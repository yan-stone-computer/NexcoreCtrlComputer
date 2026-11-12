import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SCHEMA = "nexcore.program/v1";
const PROGRAM_NAME = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;
const MAX_BYTES = 256 * 1024;
const MAX_STEPS = 20;
const TOP_LEVEL = new Set(["schema", "name", "version", "description", "params", "steps"]);
const STEP_KINDS = ["observe", "act", "verify"];
const PARAM_TYPES = new Set(["string", "number", "boolean"]);
const SURFACES = new Set(["auto", "desktop", "browser"]);
const ACTIONS = new Set([
  "open",
  "click",
  "double_click",
  "right_click",
  "hover",
  "focus",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "toggle",
  "expand",
  "collapse",
  "scroll"
]);

export class ProgramError extends Error {
  constructor(code, message, { details, retry = "safe" } = {}) {
    super(message);
    this.name = "ProgramError";
    this.code = code;
    this.details = details;
    this.retry = retry;
  }
}

function fail(code, message, details) {
  throw new ProgramError(code, message, { details });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function assertType(name, value, type) {
  if (typeof value !== type || (type === "number" && !Number.isFinite(value))) {
    fail("PARAMETER_TYPE", `Parameter "${name}" must be ${type}.`, { name, expected: type, actual: typeof value });
  }
}

function collectPlaceholders(value, output = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) output.add(match[1]);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, output);
    return output;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectPlaceholders(item, output);
  }
  return output;
}

function interpolate(value, params) {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_PLACEHOLDER);
    if (whole) {
      if (!Object.hasOwn(params, whole[1])) {
        fail("UNKNOWN_PARAMETER", `Unknown parameter: ${whole[1]}`, { parameter: whole[1] });
      }
      return params[whole[1]];
    }
    return value.replace(PLACEHOLDER, (_, name) => {
      if (!Object.hasOwn(params, name)) {
        fail("UNKNOWN_PARAMETER", `Unknown parameter: ${name}`, { parameter: name });
      }
      return String(params[name]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, params));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, params)])
    );
  }
  return value;
}

function validateUnsafe(value, path = "program") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateUnsafe(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
    fail("UNSAFE_PROGRAM", "Stored programs cannot use coordinate targets.", { path });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "target" && typeof child === "string" && child.startsWith("@")) {
      fail("UNSAFE_PROGRAM", "Stored programs cannot use a snapshot-qualified ref.", { path: `${path}.${key}` });
    }
    if (key === "headed" && child === true) {
      fail("UNSAFE_PROGRAM", "Stored programs cannot enable headed input.", { path: `${path}.${key}` });
    }
    if (key === "action" && child === "coordinate_click") {
      fail("UNSAFE_PROGRAM", "Stored programs cannot use coordinate_click.", { path: `${path}.${key}` });
    }
    if (key === "action" && child === "screenshot") {
      fail("UNSAFE_PROGRAM", "Stored programs cannot request screenshots.", { path: `${path}.${key}` });
    }
    if (["eval", "script", "code", "command", "shell"].includes(key)) {
      fail("UNSAFE_PROGRAM", `Stored programs cannot contain "${key}".`, { path: `${path}.${key}` });
    }
    validateUnsafe(child, `${path}.${key}`);
  }
}

function normalizeParams(params = {}) {
  if (!isPlainObject(params)) fail("INVALID_PROGRAM", "params must be an object.");
  const normalized = {};
  for (const [name, declaration] of Object.entries(params)) {
    if (!isPlainObject(declaration)) fail("INVALID_PROGRAM", `Parameter "${name}" must be an object.`);
    if (!PARAM_TYPES.has(declaration.type)) {
      fail("INVALID_PROGRAM", `Parameter "${name}" has unsupported type.`, {
        name,
        supported: [...PARAM_TYPES]
      });
    }
    const item = {
      type: declaration.type,
      required: declaration.required === true
    };
    if (declaration.description !== undefined) item.description = String(declaration.description);
    if (declaration.default !== undefined) {
      assertType(name, declaration.default, declaration.type);
      item.default = declaration.default;
    }
    normalized[name] = item;
  }
  return normalized;
}

function normalizeStep(step, index) {
  if (!isPlainObject(step)) fail("INVALID_PROGRAM", `Step ${index} must be an object.`);
  const kinds = STEP_KINDS.filter((kind) => Object.hasOwn(step, kind));
  if (kinds.length !== 1) {
    fail("INVALID_PROGRAM", `Step ${index} must contain exactly one of observe, act, or verify.`, { index });
  }
  const kind = kinds[0];
  const body = step[kind];
  if (!isPlainObject(body)) fail("INVALID_PROGRAM", `Step ${index}.${kind} must be an object.`, { index });
  if (body.surface !== undefined && !SURFACES.has(body.surface)) {
    fail("INVALID_PROGRAM", `Step ${index} has unsupported surface "${body.surface}".`, { index });
  }
  validateUnsafe(body, `steps[${index}].${kind}`);
  if (kind === "act") {
    if (body.action !== undefined && !ACTIONS.has(body.action)) {
      fail("INVALID_PROGRAM", `Step ${index} has unsupported action "${body.action}".`, { index });
    }
    if (!body.action) fail("INVALID_PROGRAM", `Step ${index} act requires action.`, { index });
  }
  return { [kind]: clone(body) };
}

export function validateProgram(definition) {
  if (!isPlainObject(definition)) fail("INVALID_PROGRAM", "Program must be a JSON object.");
  for (const key of Object.keys(definition)) {
    if (!TOP_LEVEL.has(key)) fail("INVALID_PROGRAM", `Unknown program field: ${key}`, { field: key });
  }
  if (definition.schema !== SCHEMA) {
    fail("UNSUPPORTED_SCHEMA", `Unsupported program schema: ${definition.schema}`, { schema: definition.schema });
  }
  if (!PROGRAM_NAME.test(definition.name || "")) {
    fail("INVALID_PROGRAM_NAME", "Program name must use lowercase letters, digits, dots, hyphens, or underscores.");
  }
  if (!VERSION.test(definition.version || "")) {
    fail("INVALID_PROGRAM", "Program version must be semantic version x.y.z.");
  }
  if (!Array.isArray(definition.steps) || definition.steps.length < 1 || definition.steps.length > MAX_STEPS) {
    fail("INVALID_PROGRAM", `Program must contain 1-${MAX_STEPS} steps.`);
  }
  const description = definition.description === undefined ? "" : String(definition.description);
  if (description.length > 500) fail("INVALID_PROGRAM", "Program description is too long.");
  const normalized = {
    schema: SCHEMA,
    name: definition.name,
    version: definition.version,
    description,
    params: normalizeParams(definition.params),
    steps: definition.steps.map(normalizeStep)
  };
  const unknown = [...collectPlaceholders(normalized.steps)]
    .filter((name) => !Object.hasOwn(normalized.params, name));
  if (unknown.length) {
    fail("UNKNOWN_PARAMETER", `Unknown parameter: ${unknown[0]}`, { parameters: unknown });
  }
  return normalized;
}

export function compileProgram(definition, params = {}) {
  const normalized = validateProgram(definition);
  if (!isPlainObject(params)) fail("INVALID_PARAMETERS", "Program parameters must be an object.");
  const unknown = Object.keys(params).filter((name) => !Object.hasOwn(normalized.params, name));
  if (unknown.length) fail("UNKNOWN_PARAMETER", `Unknown parameter: ${unknown[0]}`, { parameters: unknown });
  const values = {};
  for (const [name, declaration] of Object.entries(normalized.params)) {
    const supplied = Object.hasOwn(params, name) ? params[name] : declaration.default;
    if (supplied === undefined) {
      if (declaration.required) fail("PARAMETER_REQUIRED", `Required parameter is missing: ${name}`, { name });
      continue;
    }
    assertType(name, supplied, declaration.type);
    values[name] = supplied;
  }
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
  return {
    ...normalized,
    steps: interpolate(normalized.steps, values),
    digest
  };
}

export class ProgramStore {
  constructor({ directory = process.env.NEXCORE_PROGRAM_DIR || join(homedir(), ".nexcore", "programs") } = {}) {
    this.directory = resolve(directory);
  }

  _path(name) {
    if (!PROGRAM_NAME.test(name || "")) {
      fail("INVALID_PROGRAM_NAME", `Invalid program name: ${name}`);
    }
    return join(this.directory, `${name}.json`);
  }

  save(definition) {
    const normalized = validateProgram(definition);
    const text = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) fail("PROGRAM_TOO_LARGE", "Program exceeds 256 KiB.");
    mkdirSync(this.directory, { recursive: true });
    const destination = this._path(normalized.name);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx" });
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    return {
      name: normalized.name,
      version: normalized.version,
      description: normalized.description,
      bytes: Buffer.byteLength(text),
      path: destination
    };
  }

  list() {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((file) => {
        const path = join(this.directory, file);
        try {
          const bytes = statSync(path).size;
          if (bytes > MAX_BYTES) throw new ProgramError("PROGRAM_TOO_LARGE", "Program exceeds 256 KiB.");
          const normalized = validateProgram(JSON.parse(readFileSync(path, "utf8")));
          return {
            name: normalized.name,
            version: normalized.version,
            description: normalized.description,
            bytes,
            path
          };
        } catch (error) {
          return {
            name: file.slice(0, -5),
            path,
            error: error.code || "INVALID_PROGRAM_FILE",
            message: error.message
          };
        }
      });
  }

  get(name) {
    const path = this._path(name);
    if (!existsSync(path)) fail("PROGRAM_NOT_FOUND", `Program not found: ${name}`, { name });
    if (statSync(path).size > MAX_BYTES) fail("PROGRAM_TOO_LARGE", "Program exceeds 256 KiB.");
    let definition;
    try {
      definition = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      fail("INVALID_PROGRAM_FILE", `Cannot parse program ${name}: ${error.message}`, { name, path });
    }
    const normalized = validateProgram(definition);
    if (normalized.name !== name) {
      fail("INVALID_PROGRAM_FILE", `Program file name does not match internal name "${normalized.name}".`, { name });
    }
    return normalized;
  }
}

export class ProgramRuntime {
  constructor(computer, store) {
    this.computer = computer;
    this.store = store;
  }

  async run(name, params = {}, options = {}) {
    const source = this.store.get(name);
    const compiled = compileProgram(source, params);
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        program: compiled.name,
        version: compiled.version,
        digest: compiled.digest,
        steps: compiled.steps
      };
    }
    const started = Date.now();
    const results = await this.computer.run(compiled.steps);
    const failure = results.find((item) => !item.ok);
    if (failure) {
      throw new ProgramError("PROGRAM_FAILED", `Program failed at step ${failure.index}: ${failure.message}`, {
        details: {
          program: compiled.name,
          failure,
          completed: results.slice(0, failure.index)
        },
        retry: failure.retry || "unsafe"
      });
    }
    return {
      ok: true,
      program: compiled.name,
      version: compiled.version,
      digest: compiled.digest,
      elapsedMs: Date.now() - started,
      steps: results.map(({ index, ok, action, ref, delivery, verification, revision, bytes, estimatedTokens }) => ({
        index,
        ok,
        action,
        ref,
        delivery,
        verification,
        revision,
        bytes,
        estimatedTokens
      }))
    };
  }
}
