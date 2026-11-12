import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_BRIDGE = join(HERE, "..", "scripts", "pyautogui_bridge.py");

const DEFAULTS = Object.freeze({
  session: process.env.NEXCORE_SESSION || "default",
  desktopBin: process.env.NEXCORE_DESKTOP_BIN || "agent-desktop",
  browserBin: process.env.NEXCORE_BROWSER_BIN || "agent-browser",
  pythonBin: process.env.NEXCORE_PYTHON_BIN || "python",
  maxNodes: 120,
  maxChars: 14000,
  maxSteps: 20,
  timeoutMs: 30000,
  verifyTimeoutMs: 5000,
  allowHeaded: false,
  allowCoordinates: false,
  allowedApps: null,
  allowedDomains: null
});

function nativeBinary(pkg, stem) {
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const platform = process.platform;
  const root = process.env.NPM_CONFIG_PREFIX || (platform === "win32"
    ? join(process.env.APPDATA || "", "npm")
    : join(dirname(process.execPath), ".."));
  const roots = [
    join(process.cwd(), "node_modules"),
    join(HERE, "..", "node_modules"),
    join(root, "node_modules"),
    ...(process.env.NODE_PATH || "").split(process.platform === "win32" ? ";" : ":")
  ].filter(Boolean);
  const candidates = platform === "win32"
    ? [`${stem}-win32-${arch}.exe`]
    : [`${stem}-${platform}-${arch}`, `${stem}-${platform}-${arch}-gnu`, `${stem}-${platform}-${arch}-musl`];
  for (const base of roots) {
    for (const name of candidates) {
      const candidate = join(base, pkg, "bin", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveBackend(command, pkg, stem) {
  if (command !== pkg) return command;
  return nativeBinary(pkg, stem) || command;
}

export class NexcoreError extends Error {
  constructor(code, message, { details, retry = "unsafe", cause } = {}) {
    super(message, { cause });
    this.name = "NexcoreError";
    this.code = code;
    this.details = details;
    this.retry = retry;
  }
}

export class PolicyError extends NexcoreError {
  constructor(message, details) {
    super("POLICY_DENIED", message, { details, retry: "safe" });
    this.name = "PolicyError";
  }
}

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text), "utf8") / 4);
}

export function truncate(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function normalizeRefsForDiff(text) {
  return String(text).replace(/@s[a-z0-9]+:e(\d+)/gi, "@e$1");
}

export function diffLines(before, after, limit = 80) {
  const oldLines = String(before || "").split("\n");
  const newLines = String(after || "").split("\n");
  const counts = new Map();
  for (const line of oldLines) counts.set(line, (counts.get(line) || 0) + 1);

  const added = [];
  for (const line of newLines) {
    const count = counts.get(line) || 0;
    if (count > 0) counts.set(line, count - 1);
    else added.push(`+ ${line}`);
  }

  const removed = [];
  for (const [line, count] of counts) {
    for (let i = 0; i < count; i += 1) removed.push(`- ${line}`);
  }

  const changes = [...removed, ...added];
  if (changes.length === 0) return "unchanged";
  if (changes.length <= limit) return changes.join("\n");
  return `${changes.slice(0, limit).join("\n")}\n… ${changes.length - limit} more changes`;
}

function flattenDesktop(node, out = [], depth = 0) {
  if (!node || typeof node !== "object") return out;
  out.push({ ...node, depth });
  for (const child of node.children || []) flattenDesktop(child, out, depth + 1);
  return out;
}

function matchesQuery(node, query) {
  if (!query) return true;
  const needle = String(query).toLocaleLowerCase();
  return ["role", "name", "value", "description"].some((key) =>
    String(node[key] ?? "").toLocaleLowerCase().includes(needle)
  );
}

export function desktopRecords(data, options = {}) {
  const root = data?.tree || data?.match || data;
  return flattenDesktop(root)
    .filter((node) => node.ref_id || node.name || node.value)
    .filter((node) => !options.interactiveOnly || node.ref_id || node.children?.length)
    .filter((node) => matchesQuery(node, options.query));
}

export function compactDesktopSnapshot(data, options = {}) {
  const maxNodes = options.maxNodes ?? DEFAULTS.maxNodes;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const records = desktopRecords(data, options);
  const lines = [];

  for (const node of records) {
    if (lines.length >= maxNodes) break;
    const role = truncate(node.role || "node", 32);
    const ref = node.ref_id ? `${node.ref_id} ` : "";
    const name = node.name ? ` "${truncate(node.name)}"` : "";
    const value = node.value !== undefined ? ` = "${truncate(node.value)}"` : "";
    const states = node.states?.length ? ` {${node.states.slice(0, 4).join(",")}}` : "";
    const actions = node.available_actions?.length
      ? ` [${node.available_actions.slice(0, 5).map((item) => item.toLowerCase()).join(",")}]`
      : "";
    lines.push(`${ref}${role}${name}${value}${states}${actions}`);
  }

  const omitted = Math.max(0, records.length - lines.length);
  if (omitted) lines.push(`… ${omitted} more nodes; narrow with query, root, or maxNodes`);
  let text = lines.join("\n") || "(no matching elements)";
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n… output capped`;
  return {
    text,
    records,
    refs: records.filter((node) => node.ref_id).map((node) => ({
      ref: node.ref_id,
      role: node.role,
      name: node.name,
      value: node.value
    }))
  };
}

export function compactBrowserSnapshot(data, options = {}) {
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  let text = String(data?.snapshot || "").trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n… output capped`;
  if (!text) text = "(no matching elements)";
  const refs = Object.entries(data?.refs || {}).map(([name, value]) => ({
    ref: name.startsWith("@") ? name : `@${name}`,
    role: value?.role,
    name: value?.name,
    value: value?.value
  }));
  return { text, refs };
}

export class ActionPolicy {
  constructor(options = {}) {
    this.allowHeaded = Boolean(options.allowHeaded);
    this.allowCoordinates = Boolean(options.allowCoordinates);
    this.allowedApps = options.allowedApps ? [...options.allowedApps] : null;
    this.allowedDomains = options.allowedDomains ? [...options.allowedDomains] : null;
  }

  requireHeaded(method, headed) {
    if (headed && !this.allowHeaded) {
      throw new PolicyError(`${method} requires headed input, but allowHeaded is false.`, {
        action: method,
        hint: "Opt in with policy.allowHeaded and prefer semantic actions first."
      });
    }
  }

  requireCoordinates() {
    if (!this.allowCoordinates) {
      throw new PolicyError("Coordinate control is disabled; use an accessibility ref.", {
        hint: "Opt in with policy.allowCoordinates only for canvas or unlabeled surfaces."
      });
    }
  }

  checkApp(app) {
    if (!this.allowedApps || !app) return;
    const normalized = String(app).toLocaleLowerCase();
    const allowed = this.allowedApps.some((item) => {
      const rule = String(item).toLocaleLowerCase();
      return rule === "*" || rule === normalized || (rule.endsWith("*") && normalized.startsWith(rule.slice(0, -1)));
    });
    if (!allowed) throw new PolicyError(`App "${app}" is not in allowedApps.`, { allowedApps: this.allowedApps });
  }

  checkUrl(url) {
    if (!this.allowedDomains || !url) return;
    let hostname;
    try {
      hostname = new URL(url).hostname.toLocaleLowerCase();
    } catch {
      throw new NexcoreError("INVALID_URL", `Invalid URL: ${url}`, { retry: "safe" });
    }
    const allowed = this.allowedDomains.some((item) => {
      const rule = String(item).toLocaleLowerCase();
      return rule === "*" || hostname === rule || (rule.startsWith("*.") && hostname.endsWith(rule.slice(1)));
    });
    if (!allowed) throw new PolicyError(`Domain "${hostname}" is not in allowedDomains.`, { hostname });
  }
}

function runProcess(command, args, { input, timeoutMs = DEFAULTS.timeoutMs, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new NexcoreError("TIMEOUT", `${command} exceeded ${timeoutMs}ms.`, { retry: "unsafe" }));
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (error.code === "ENOENT") {
        reject(new NexcoreError("BACKEND_MISSING", `Command not found: ${command}`, {
          details: { command, hint: `Install it or set the matching NEXCORE_*_BIN environment variable.` },
          retry: "safe",
          cause: error
        }));
      } else {
        reject(new NexcoreError("PROCESS_ERROR", error.message, { retry: "safe", cause: error }));
      }
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseJson(text, command) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new NexcoreError("EMPTY_OUTPUT", `${command} returned no output.`, { retry: "safe" });
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].trimStart().startsWith("{")) continue;
      try {
        return JSON.parse(lines.slice(index).join("\n"));
      } catch {
        // Keep looking for the last complete JSON envelope.
      }
    }
    throw new NexcoreError("INVALID_OUTPUT", `${command} returned non-JSON output.`, {
      details: { preview: truncate(trimmed, 500) },
      retry: "safe",
      cause
    });
  }
}

function backendError(command, envelope, stderr) {
  const error = envelope?.error || envelope;
  const retry = error?.disposition?.retry || (error?.recovery?.retryable ? "safe" : "unsafe");
  return new NexcoreError(
    error?.code || "BACKEND_ERROR",
    error?.message || `${command} failed.`,
    {
      details: { ...(error?.details || {}), suggestion: error?.suggestion, stderr: truncate(stderr, 400) },
      retry
    }
  );
}

function normalizeEnvelope(envelope, command, stderr) {
  if (envelope?.ok === false || envelope?.success === false) throw backendError(command, envelope, stderr);
  return envelope?.data ?? envelope;
}

function targetMatches(entry, target) {
  if (!target?.role && !target?.name) return true;
  const roleOk = !target.role || String(entry.role || "").toLocaleLowerCase() === String(target.role).toLocaleLowerCase();
  const nameOk = !target.name || String(entry.name ?? "") === String(target.name);
  return roleOk && nameOk;
}

function actionResult(surface, action, data, extra = {}) {
  const disposition = data?.disposition || data?.result?.disposition || {};
  return {
    surface,
    action,
    delivery: disposition.delivery || (data?.success === false ? "not_delivered" : "delivered"),
    retry: disposition.retry || "unsafe",
    ...extra
  };
}

export class Computer {
  constructor(options = {}) {
    this.config = {
      ...DEFAULTS,
      ...options,
      policy: options.policy || {}
    };
    this.config.desktopBin = resolveBackend(this.config.desktopBin, "agent-desktop", "agent-desktop");
    this.config.browserBin = resolveBackend(this.config.browserBin, "agent-browser", "agent-browser");
    this.policy = options.policy instanceof ActionPolicy ? options.policy : new ActionPolicy(options.policy);
    this.previous = new Map();
    this.closed = false;
  }

  _ensureOpen() {
    if (this.closed) throw new NexcoreError("CLOSED", "This controller is closed.", { retry: "safe" });
  }

  async _run(command, args, options = {}) {
    const started = Date.now();
    const result = await runProcess(command, args, {
      input: options.input,
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs
    });
    if (!result.stdout.trim() && result.code !== 0) {
      throw new NexcoreError("BACKEND_ERROR", result.stderr.trim() || `${command} exited ${result.code}.`, {
        retry: "safe"
      });
    }
    const envelope = parseJson(result.stdout, command);
    const data = normalizeEnvelope(envelope, command, result.stderr);
    return { data, envelope, stderr: result.stderr, elapsedMs: Date.now() - started };
  }

  async _desktop(args, { headed = false, input, timeoutMs } = {}) {
    const prefix = headed ? ["--headed"] : [];
    const session = args[0] === "status" ? [] : ["--session", this.config.session];
    return this._run(this.config.desktopBin, [...prefix, ...args, ...session], { input, timeoutMs });
  }

  async _browser(args, { headed = false, timeoutMs } = {}) {
    const prefix = ["--json", "--session", this.config.session];
    if (headed) prefix.push("--headed");
    if (this.policy.allowedDomains) prefix.push("--allowed-domains", this.policy.allowedDomains.join(","));
    return this._run(this.config.browserBin, [...prefix, ...args], { timeoutMs });
  }

  async doctor() {
    this._ensureOpen();
    const probe = async (name, command, args) => {
      try {
        const result = await this._run(command, args, { timeoutMs: 15000 });
        return { name, ok: true, data: result.data, elapsedMs: result.elapsedMs };
      } catch (error) {
        return { name, ok: false, code: error.code, message: error.message, details: error.details };
      }
    };
    const [desktop, browser, pyautogui] = await Promise.all([
      probe("desktop", this.config.desktopBin, ["status"]),
      probe("browser", this.config.browserBin, ["--json", "doctor"]),
      this._pyautogui({ action: "status" }).then(
        (data) => ({ name: "pyautogui", ok: true, data }),
        (error) => ({ name: "pyautogui", ok: false, code: error.code, message: error.message })
      )
    ]);
    const desktopSummary = desktop.ok ? {
      ok: true,
      version: desktop.data.version,
      platform: desktop.data.platform,
      accessibility: desktop.data.permissions?.accessibility?.state,
      surfaces: desktop.data.supported_surfaces || [],
      elapsedMs: desktop.elapsedMs
    } : desktop;
    const browserChecks = browser.ok ? (browser.data.checks || []) : [];
    const browserSummary = browser.ok ? {
      ok: browser.data.success !== false,
      version: browserChecks.find((item) => item.id === "env.version")?.message,
      chrome: browserChecks.find((item) => item.id === "chrome.installed")?.message,
      summary: browser.data.summary,
      warnings: browserChecks
        .filter((item) => item.status === "fail" || item.status === "warn")
        .map((item) => ({ id: item.id, status: item.status, message: item.message })),
      elapsedMs: browser.elapsedMs
    } : browser;
    return {
      ok: desktop.ok && browser.ok,
      desktop: desktopSummary,
      browser: browserSummary,
      pyautogui,
      policy: {
        allowHeaded: this.policy.allowHeaded,
        allowCoordinates: this.policy.allowCoordinates,
        allowedApps: this.policy.allowedApps,
        allowedDomains: this.policy.allowedDomains
      }
    };
  }

  async _pyautogui(payload) {
    if (!existsSync(PY_BRIDGE)) {
      throw new NexcoreError("BRIDGE_MISSING", `Python bridge not found: ${PY_BRIDGE}`, { retry: "safe" });
    }
    const result = await this._run(this.config.pythonBin, [PY_BRIDGE], {
      input: JSON.stringify(payload),
      timeoutMs: payload.timeoutMs || this.config.timeoutMs
    });
    return result.data;
  }

  _surface(input) {
    if (input.surface && input.surface !== "auto") return input.surface;
    if (input.url) return "browser";
    return "desktop";
  }

  _remember(key, text) {
    const normalized = normalizeRefsForDiff(text);
    const previous = this.previous.get(key);
    const revision = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    this.previous.set(key, { text: normalized, revision });
    return { previous, revision };
  }

  async observe(input = {}) {
    this._ensureOpen();
    const surface = this._surface(input);
    const delta = input.delta !== false;
    const key = [
      surface,
      this.config.session,
      input.app || input.url || input.root || "active",
      input.query || "",
      input.selector || "",
      input.depth || "",
      input.maxNodes || "",
      input.interactiveOnly !== false
    ].join(":");
    let result;

    if (surface === "desktop") {
      this.policy.checkApp(input.app);
      const args = ["snapshot"];
      if (input.app) args.push("--app", input.app);
      if (input.root) args.push("--root", input.root);
      if (input.surfaceKind) args.push("--surface", input.surfaceKind);
      args.push("--interactive-only", "--compact");
      if (input.depth) args.push("--max-depth", String(Math.max(1, Math.min(50, input.depth))));
      if (input.includeBounds) args.push("--include-bounds");
      const response = await this._desktop(args);
      const compact = compactDesktopSnapshot(response.data, {
        maxNodes: input.maxNodes ?? this.config.maxNodes,
        maxChars: input.maxChars ?? this.config.maxChars,
        query: input.query,
        interactiveOnly: input.interactiveOnly !== false
      });
      const header = `desktop ${compactDesktopSnapshot({ role: "app", name: input.app || "active" }).text.split("\n")[0] || ""}`.trim();
      const body = `${header}\n${compact.text}`;
      const remembered = this._remember(key, body);
      const output = delta && remembered.previous ? diffLines(remembered.previous.text, body) : body;
      result = {
        surface,
        app: input.app,
        revision: remembered.revision,
        complete: response.data.complete !== false,
        text: output,
        refs: compact.refs,
        elapsedMs: response.elapsedMs
      };
    } else if (surface === "browser") {
      this.policy.checkUrl(input.url);
      if (input.url && input.open !== false) {
        await this._browser(["open", input.url]);
      }
      const args = ["snapshot", "-i", "-c"];
      if (input.depth) args.push("-d", String(Math.max(1, Math.min(50, input.depth))));
      if (input.selector) args.push("-s", input.selector);
      const response = await this._browser(args);
      const compact = compactBrowserSnapshot(response.data, { maxChars: input.maxChars ?? this.config.maxChars });
      const filtered = input.query
        ? compact.text
            .split("\n")
            .filter((line) => line.toLocaleLowerCase().includes(String(input.query).toLocaleLowerCase()))
            .join("\n") || "(no matching elements)"
        : compact.text;
      const url = response.data.url ? `\nurl: ${response.data.url}` : "";
      const body = `browser\n${filtered}${url}`;
      const remembered = this._remember(key, body);
      const output = delta && remembered.previous ? diffLines(remembered.previous.text, body) : body;
      result = {
        surface,
        url: response.data.url || input.url,
        revision: remembered.revision,
        complete: true,
        text: output,
        refs: compact.refs.filter((entry) => targetMatches(entry, input.target)),
        elapsedMs: response.elapsedMs
      };
    } else {
      throw new NexcoreError("INVALID_SURFACE", `Unknown surface: ${surface}`, { retry: "safe" });
    }

    result.bytes = Buffer.byteLength(result.text, "utf8");
    result.estimatedTokens = estimateTokens(result.text);
    return result;
  }

  async _desktopExactFind(app, target) {
    const args = [
      "find",
      "--app",
      app,
      "--role",
      target.role,
      "--name",
      target.name,
      "--exact",
      "--timeout-ms",
      "5000"
    ];
    if (target.near) {
      if (!target.near.role || !target.near.name) {
        throw new NexcoreError("INVALID_TARGET", "A contextual target needs near.role and near.name.", { retry: "safe" });
      }
      const context = await this._desktopExactFind(app, target.near);
      if (!context) {
        throw new NexcoreError("TARGET_NOT_FOUND", "No semantic target matched the context.", {
          details: { near: target.near },
          retry: "safe"
        });
      }
      args.push("--root", context.match.ref_id);
    }
    const response = await this._desktop(args);
    const matches = response.data.match ? [response.data.match] : response.data.matches || [];
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new NexcoreError("AMBIGUOUS_TARGET", "More than one exact semantic target matched.", {
        details: { matches: matches.slice(0, 8) },
        retry: "safe"
      });
    }
    return { match: matches[0], elapsedMs: response.elapsedMs };
  }

  async _resolveTargetDetailed(input, surface) {
    if (typeof input.target === "string" && input.target.startsWith("@")) {
      return { ref: input.target, strategy: "provided-ref" };
    }
    if (surface === "browser" && input.target?.selector) {
      return { ref: input.target.selector, strategy: "selector" };
    }
    if (input.target && Number.isFinite(input.target.x) && Number.isFinite(input.target.y)) {
      return { ref: input.target, strategy: "coordinates" };
    }
    if (!input.target) {
      throw new NexcoreError("TARGET_REQUIRED", "This action needs target: a ref, role/name object, or coordinates.", {
        retry: "safe"
      });
    }
    if (surface === "browser" && input.target.near) {
      throw new NexcoreError("INVALID_TARGET", "Contextual targets are currently supported for desktop only.", {
        retry: "safe"
      });
    }

    if (surface === "desktop" && input.app && input.target.role && input.target.name) {
      try {
        const exact = await this._desktopExactFind(input.app, input.target);
        if (exact) {
          return {
            ref: exact.match.ref_id,
            strategy: input.target.near ? "context-find" : "exact-find",
            path: exact.match.path,
            elapsedMs: exact.elapsedMs
          };
        }
      } catch (error) {
        if (error.code === "AMBIGUOUS_TARGET") throw error;
        if (!["TARGET_NOT_FOUND", "NO_MATCH", "ELEMENT_NOT_FOUND"].includes(error.code)) throw error;
      }
    }

    const observed = await this.observe({
      surface,
      app: input.app,
      url: input.url,
      open: false,
      query: input.target.name || input.target.role,
      delta: false,
      maxNodes: Math.max(this.config.maxNodes, 300),
      interactiveOnly: true
    });
    const matches = observed.refs.filter((entry) => targetMatches(entry, input.target));
    if (matches.length === 0) {
      throw new NexcoreError("TARGET_NOT_FOUND", "No accessible ref matched the target.", {
        details: { target: input.target },
        retry: "safe"
      });
    }
    if (matches.length > 1 && input.target.first !== true) {
      throw new NexcoreError("AMBIGUOUS_TARGET", "More than one ref matched; add more fields or set first:true.", {
        details: { matches: matches.slice(0, 8) },
        retry: "safe"
      });
    }
    return { ref: matches[0].ref, strategy: "snapshot-fallback", elapsedMs: observed.elapsedMs };
  }

  async _resolveTarget(input, surface) {
    return (await this._resolveTargetDetailed(input, surface)).ref;
  }

  async act(input = {}) {
    this._ensureOpen();
    const surface = this._surface(input);
    const action = input.action;
    if (!action) throw new NexcoreError("ACTION_REQUIRED", "action is required.", { retry: "safe" });
    this.policy.requireHeaded(action, input.headed);

    if (action === "coordinate_click") {
      this.policy.requireCoordinates();
      const target = input.target;
      if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
        throw new NexcoreError("TARGET_REQUIRED", "coordinate_click needs {x,y}.", { retry: "safe" });
      }
      const data = await this._pyautogui({ action: "click", x: target.x, y: target.y, timeoutMs: this.config.timeoutMs });
      return { surface: "coordinate", action, delivery: "delivered_unverified", retry: "unsafe", data };
    }

    if (action === "open") {
      if (surface === "browser") {
        this.policy.checkUrl(input.url);
        if (!input.url) throw new NexcoreError("URL_REQUIRED", "open needs url.", { retry: "safe" });
        const response = await this._browser(["open", input.url], { headed: input.headed });
        return actionResult("browser", action, response.data, { ref: null, url: input.url, elapsedMs: response.elapsedMs });
      }
      this.policy.checkApp(input.app);
      if (!input.app) throw new NexcoreError("APP_REQUIRED", "Desktop open needs app.", { retry: "safe" });
      const response = await this._desktop([
        "launch",
        input.app,
        "--activate",
        "--timeout",
        String(input.timeoutMs || this.config.timeoutMs)
      ], { headed: input.headed });
      return actionResult("desktop", action, response.data, { elapsedMs: response.elapsedMs });
    }

    if (action === "screenshot") {
      const path = input.path || defaultScreenshotPath(`nexcore-${Date.now()}.png`);
      const response = surface === "desktop"
        ? await this._desktop(["screenshot", path, ...(input.app ? ["--app", input.app] : [])], { headed: input.headed })
        : await this._browser(["screenshot", path], { headed: input.headed });
      return actionResult(surface, action, response.data, { path, elapsedMs: response.elapsedMs });
    }

    let ref = null;
    let resolution;
    if (action !== "press" && !(surface === "browser" && action === "scroll" && !input.target)) {
      if (surface === "browser" && input.url && typeof input.target !== "string" && input.open !== false) {
        this.policy.checkUrl(input.url);
        await this._browser(["open", input.url], { headed: input.headed });
      }
      resolution = await this._resolveTargetDetailed(input, surface);
      ref = resolution.ref;
    }
    let response;
    const timeoutArgs = input.timeoutMs ? ["--timeout-ms", String(input.timeoutMs)] : [];

    if (surface === "desktop") {
      const desktopMap = {
        click: ["click", ref],
        double_click: ["double-click", ref],
        right_click: ["right-click", ref],
        hover: ["hover", ref],
        focus: ["focus", ref],
        check: ["check", ref],
        uncheck: ["uncheck", ref],
        toggle: ["toggle", ref],
        expand: ["expand", ref],
        collapse: ["collapse", ref]
      };
      if (desktopMap[action]) {
        response = await this._desktop([...desktopMap[action], ...timeoutArgs], { headed: input.headed });
      } else if (action === "fill" || action === "type") {
        const command = action === "fill" ? "set-value" : "type";
        const value = input.text ?? input.value ?? "";
        response = await this._desktop([command, ref, "--stdin", ...timeoutArgs], {
          headed: input.headed,
          input: value
        });
      } else if (action === "press") {
        if (!input.keys) throw new NexcoreError("KEYS_REQUIRED", "press needs keys.", { retry: "safe" });
        response = await this._desktop(["press", input.keys, ...timeoutArgs], { headed: input.headed });
      } else if (action === "select") {
        if (input.value === undefined) throw new NexcoreError("VALUE_REQUIRED", "select needs value.", { retry: "safe" });
        response = await this._desktop(["select", ref, String(input.value), ...timeoutArgs], { headed: input.headed });
      } else if (action === "scroll") {
        response = await this._desktop([
          "scroll",
          ref,
          "--direction",
          input.direction || "down",
          "--amount",
          String(input.amount || 3),
          ...timeoutArgs
        ], { headed: input.headed });
      } else {
        throw new NexcoreError("ACTION_NOT_SUPPORTED", `Desktop action not supported: ${action}`, { retry: "safe" });
      }
    } else {
      const browserMap = {
        click: ["click", ref],
        double_click: ["dblclick", ref],
        hover: ["hover", ref],
        focus: ["focus", ref],
        check: ["check", ref],
        uncheck: ["uncheck", ref]
      };
      if (browserMap[action]) {
        response = await this._browser(browserMap[action], { headed: input.headed });
      } else if (action === "fill" || action === "type") {
        const value = input.text ?? input.value ?? "";
        response = await this._browser([action, ref, "--", value], { headed: input.headed });
      } else if (action === "press") {
        if (!input.keys) throw new NexcoreError("KEYS_REQUIRED", "press needs keys.", { retry: "safe" });
        response = await this._browser(["press", input.keys], { headed: input.headed });
      } else if (action === "select") {
        if (input.value === undefined) throw new NexcoreError("VALUE_REQUIRED", "select needs value.", { retry: "safe" });
        response = await this._browser(["select", ref, String(input.value)], { headed: input.headed });
      } else if (action === "scroll") {
        response = await this._browser(["scroll", input.direction || "down", String(input.amount || 3)], {
          headed: input.headed
        });
      } else {
        throw new NexcoreError("ACTION_NOT_SUPPORTED", `Browser action not supported: ${action}`, { retry: "safe" });
      }
    }

    const result = actionResult(surface, action, response.data, {
      ref,
      resolution,
      elapsedMs: response.elapsedMs
    });
    if (input.expect) result.verification = await this.verify({ ...input.expect, surface, app: input.app, url: input.url, ref });
    return result;
  }

  async verify(expect = {}) {
    this._ensureOpen();
    const surface = expect.surface || "desktop";
    const property = expect.property || "value";
    const expected = String(expect.value ?? "");
    const timeoutMs = expect.timeoutMs || this.config.verifyTimeoutMs;
    const ref = property === "url" ? null : expect.ref || await this._resolveTarget(
      { ...expect, target: expect.target },
      surface
    );

    if (surface === "desktop") {
      const predicate = property === "value" ? "value" : property;
      const response = await this._desktop([
        "wait",
        "--element",
        ref,
        "--predicate",
        predicate,
        "--value",
        expected,
        "--timeout",
        String(timeoutMs)
      ]);
      return { ok: response.data.found === true, ref, property, expected, observed: response.data.observed };
    }

    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() <= deadline) {
      const response = property === "url"
        ? await this._browser(["get", "url"])
        : await this._browser(["get", property, ref]);
      last = response.data;
      const observed = String(last?.url ?? last?.value ?? last?.result ?? last ?? "");
      if (observed === expected) return { ok: true, ref, property, expected, observed: last };
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    }
    throw new NexcoreError("VERIFY_TIMEOUT", `Expected ${property}=${expected}; last value did not match.`, {
      details: { ref, last },
      retry: "unsafe"
    });
  }

  async run(steps, options = {}) {
    this._ensureOpen();
    if (!Array.isArray(steps)) throw new NexcoreError("INVALID_STEPS", "steps must be an array.", { retry: "safe" });
    const limit = options.limit || this.config.maxSteps;
    if (steps.length > limit) {
      throw new NexcoreError("STEP_LIMIT", `A run is limited to ${limit} steps.`, { retry: "safe" });
    }
    const results = [];
    for (const [index, step] of steps.entries()) {
      try {
        const mode = step.mode || (step.observe ? "observe" : step.act ? "act" : step.action ? "act" : null);
        const payload = step.observe || step.act || step;
        if (mode === "observe") {
          const result = await this.observe(payload);
          results.push({ index, ok: true, ...result });
        } else if (mode === "act") {
          const result = await this.act(payload);
          results.push({ index, ok: true, ...result });
        } else if (mode === "verify") {
          const result = await this.verify(payload);
          results.push({ index, ok: true, ...result });
        } else {
          throw new NexcoreError("INVALID_STEP", `Step ${index} has no observe, act, verify, action, or mode field.`, {
            retry: "safe"
          });
        }
      } catch (error) {
        results.push({ index, ok: false, code: error.code, message: error.message, retry: error.retry });
        if (!options.continueOnError) break;
      }
    }
    return results;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([
      this._run(this.config.browserBin, ["--json", "--session", this.config.session, "close"], { timeoutMs: 5000 })
    ]);
  }
}

export async function createComputer(options = {}) {
  return new Computer(options);
}

export function defaultScreenshotPath(name = "nexcore.png") {
  return resolve(join(tmpdir(), name));
}
