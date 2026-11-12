# Semantic Program Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable, parameterized, cross-surface semantic UI programs that resolve targets locally and reduce repeat model planning to one `program_run` call.

**Architecture:** A pure compiler validates portable program JSON and substitutes typed parameters. A file-backed registry stores templates. A runtime delegates each step to the existing `Computer` action contract while preferring exact accessibility lookup before broader snapshots. The existing single MCP tool gains three program modes.

**Tech Stack:** Node.js 20+, ESM, built-in `node:test`, `node:fs`, `node:crypto`, existing agent-desktop/agent-browser adapters.

**Spec:** `docs/superpowers/specs/2026-11-12-semantic-program-runtime-design.md`

## Global Constraints

- Package version becomes `0.2.0`.
- Keep zero npm runtime dependencies.
- Keep one MCP tool named `computer`.
- Stored programs must not contain snapshot refs, coordinates, screenshots, `headed: true`, shell commands, or arbitrary JavaScript.
- Default program directory is `~/.nexcore/programs`; `NEXCORE_PROGRAM_DIR` overrides it.
- Program files are limited to 256 KiB.
- Program names match `^[a-z0-9][a-z0-9._-]{1,80}$`.
- Programs execute sequentially and stop on the first failure.
- App/domain allowlists and headed/coordinate policy still apply at execution time.
- Post-delivery failures are never automatically replayed.
- Existing 0.1.0 CLI, JS, and MCP behavior remains compatible.

---

### Task 1: Program Compiler

**Files:**
- Create: `src/programs.js`
- Create: `tests/programs.test.js`

**Interfaces:**

- Consumes: plain JavaScript program objects.
- Produces:
  - `compileProgram(definition, params = {}) -> CompiledProgram`
  - `validateProgram(definition) -> NormalizedProgram`
  - `ProgramError extends Error` with `code`, `details`, `retry`
  - `CompiledProgram` fields: `schema`, `name`, `version`, `description`, `params`, `steps`, `digest`

- [ ] **Step 1: Write failing compiler tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { compileProgram } from "../src/programs.js";

const template = {
  schema: "nexcore.program/v1",
  name: "calculator.add",
  version: "1.0.0",
  description: "Enter two values.",
  params: {
    app: { type: "string", default: "Calculator" },
    a: { type: "string", required: true },
    b: { type: "string", required: true }
  },
  steps: [
    {
      act: {
        surface: "desktop",
        app: "{{app}}",
        action: "click",
        target: { role: "button", name: "{{a}}" },
        expect: {
          target: { role: "textfield", name: "Display" },
          property: "value",
          value: "{{a}}{{b}}"
        }
      }
    }
  ]
};

test("compiler applies defaults and typed interpolation", () => {
  const result = compileProgram(template, { a: "7", b: "5" });
  assert.equal(result.steps[0].act.app, "Calculator");
  assert.equal(result.steps[0].act.target.name, "7");
  assert.equal(result.steps[0].act.expect.value, "75");
  assert.match(result.digest, /^[a-f0-9]{16}$/);
});

test("compiler rejects required parameters that are absent", () => {
  assert.throws(() => compileProgram(template, { a: "7" }), /required parameter.*b/i);
});

test("compiler rejects unresolved placeholders", () => {
  assert.throws(
    () => compileProgram({ ...template, params: {}, steps: [{ observe: { app: "{{missing}}" } }] }, {}),
    /unknown parameter.*missing/i
  );
});

test("compiler rejects cross-run refs, coordinates, and headed mode", () => {
  assert.throws(
    () => compileProgram({
      schema: "nexcore.program/v1",
      name: "unsafe.ref",
      version: "1.0.0",
      steps: [{ act: { action: "click", target: "@sabc123:e1" } }]
    }),
    /snapshot-qualified ref/i
  );
  assert.throws(
    () => compileProgram({
      schema: "nexcore.program/v1",
      name: "unsafe.coordinate",
      version: "1.0.0",
      steps: [{ act: { action: "coordinate_click", target: { x: 1, y: 2 } } }]
    }),
    /coordinate/i
  );
  assert.throws(
    () => compileProgram({
      schema: "nexcore.program/v1",
      name: "unsafe.headed",
      version: "1.0.0",
      steps: [{ act: { action: "click", target: { role: "button", name: "OK" }, headed: true } }]
    }),
    /headed/i
  );
});
```

- [ ] **Step 2: Run the compiler tests and verify they fail**

Run: `node --test tests/programs.test.js`

Expected: FAIL because `src/programs.js` does not exist.

- [ ] **Step 3: Implement validation and interpolation**

```js
const SCHEMA = "nexcore.program/v1";
const NAME = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const ACTIONS = new Set([
  "open", "click", "double_click", "right_click", "hover", "focus",
  "fill", "type", "press", "select", "check", "uncheck", "toggle",
  "expand", "collapse", "scroll"
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

function interpolate(value, params) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/);
    if (whole) {
      if (!(whole[1] in params)) {
        throw new ProgramError("UNKNOWN_PARAMETER", `Unknown parameter: ${whole[1]}`);
      }
      return params[whole[1]];
    }
    return value.replace(PLACEHOLDER, (_, name) => {
      if (!(name in params)) {
        throw new ProgramError("UNKNOWN_PARAMETER", `Unknown parameter: ${name}`);
      }
      return String(params[name]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, params)])
    );
  }
  return value;
}
```

Add recursive unsafe-field validation that rejects every `target` string beginning with `@`, any target with finite `x` and `y`, `action === "coordinate_click"`, `action === "screenshot"`, and any truthy `headed` field. Validate each step has exactly one of `observe`, `act`, or `verify`. Return a normalized deep copy and a canonical SHA-256 digest truncated to 16 hex characters.

- [ ] **Step 4: Run compiler tests**

Run: `node --test tests/programs.test.js`

Expected: all compiler tests PASS.

- [ ] **Step 5: Commit compiler**

```bash
git add src/programs.js tests/programs.test.js
git commit -m "feat: compile semantic UI programs"
```

### Task 2: Program Store and Runtime

**Files:**
- Modify: `src/programs.js`
- Modify: `tests/programs.test.js`

**Interfaces:**

- Consumes: `compileProgram`, `validateProgram`, a `Computer` instance with `run(steps, options)`.
- Produces:
  - `ProgramStore({ directory })`
  - `store.save(definition) -> summary`
  - `store.list() -> summary[]`
  - `store.get(name) -> normalized program`
  - `ProgramRuntime(computer, store).run(name, params, options) -> ProgramResult`
  - Runtime result: `{ ok, program, version, digest, steps, elapsedMs }`

- [ ] **Step 1: Write failing storage and runtime tests**

```js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgramStore, ProgramRuntime, compileProgram } from "../src/programs.js";

test("program store saves, lists, and loads portable JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "nexcore-program-test-"));
  try {
    const store = new ProgramStore({ directory });
    store.save({
      schema: "nexcore.program/v1",
      name: "browser.fill",
      version: "1.0.0",
      params: { value: { type: "string", required: true } },
      steps: [{
        act: {
          surface: "browser",
          action: "fill",
          target: { role: "textbox", name: "Name" },
          text: "{{value}}"
        }
      }]
    });
    assert.deepEqual(store.list().map((item) => item.name), ["browser.fill"]);
    assert.equal(store.get("browser.fill").version, "1.0.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime delegates compiled steps and omits routine observation text", async () => {
  const calls = [];
  const fakeComputer = {
    async run(steps) {
      calls.push(steps);
      return [
        { index: 0, ok: true, text: "large snapshot", bytes: 9999 },
        { index: 1, ok: true, action: "click", ref: "@e1" }
      ];
    }
  };
  const store = {
    get() {
      return {
        schema: "nexcore.program/v1",
        name: "demo",
        version: "1.0.0",
        params: { a: { type: "string", required: true } },
        steps: [{ act: { action: "click", target: { role: "button", name: "{{a}}" } } }]
      };
    }
  };
  const runtime = new ProgramRuntime(fakeComputer, store);
  const result = await runtime.run("demo", { a: "Save" });
  assert.equal(result.ok, true);
  assert.equal(calls[0][0].act.target.name, "Save");
  assert.equal(result.steps[0].text, undefined);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/programs.test.js`

Expected: FAIL because `ProgramStore` and `ProgramRuntime` are not exported.

- [ ] **Step 3: Implement atomic store and compact runtime**

```js
export class ProgramStore {
  constructor({ directory = process.env.NEXCORE_PROGRAM_DIR || join(homedir(), ".nexcore", "programs") } = {}) {
    this.directory = resolve(directory);
  }

  save(definition) {
    const normalized = validateProgram(definition);
    mkdirSync(this.directory, { recursive: true });
    const text = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(text) > 262144) {
      throw new ProgramError("PROGRAM_TOO_LARGE", "Program exceeds 256 KiB.");
    }
    const destination = this._path(normalized.name);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, destination);
    return { name: normalized.name, version: normalized.version, path: destination };
  }
}
```

Implement `_path`, `list`, and `get` with name validation, 256 KiB read limits, JSON parse errors mapped to `INVALID_PROGRAM_FILE`, and unsupported schemas rejected via `validateProgram`.

Implement `ProgramRuntime.run`:

```js
const source = store.get(name);
const compiled = compileProgram(source, params);
const started = Date.now();
const results = await computer.run(compiled.steps);
const failure = results.find((item) => !item.ok);
if (failure) {
  throw new ProgramError("PROGRAM_FAILED", `Program failed at step ${failure.index}: ${failure.message}`, {
    details: { failure, completed: results.slice(0, failure.index) },
    retry: failure.retry || "unsafe"
  });
}
return {
  ok: true,
  program: compiled.name,
  version: compiled.version,
  digest: compiled.digest,
  elapsedMs: Date.now() - started,
  steps: results.map(({ index, ok, action, ref, delivery, verification }) => ({
    index, ok, action, ref, delivery, verification
  }))
};
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/programs.test.js`

Expected: all compiler, storage, and runtime tests PASS.

- [ ] **Step 5: Commit store and runtime**

```bash
git add src/programs.js tests/programs.test.js
git commit -m "feat: persist and run semantic programs"
```

### Task 3: Adaptive Target Resolution

**Files:**
- Modify: `src/index.js`
- Modify: `tests/core.test.js`

**Interfaces:**

- Consumes: existing `Computer._desktop`, `Computer.observe`, `ActionPolicy`.
- Produces: `Computer._resolveTargetDetailed(input, surface) -> { ref, strategy, path? }`.
- Strategy values: `provided-ref`, `selector`, `exact-find`, `context-find`, `snapshot-fallback`, `coordinates`.

- [ ] **Step 1: Write a failing exact-find test**

```js
import { Computer } from "../src/index.js";

test("desktop semantic targets use exact find before a snapshot", async () => {
  const computer = new Computer({ desktopBin: "unused" });
  const calls = [];
  computer._desktop = async (args) => {
    calls.push(args);
    return {
      data: {
        match: { ref_id: "@sfound:e1", role: "button", name: "7", path: ["window:Calculator"] }
      },
      elapsedMs: 3
    };
  };
  const resolved = await computer._resolveTargetDetailed({
    app: "Calculator",
    target: { role: "button", name: "7" }
  }, "desktop");
  assert.equal(resolved.ref, "@sfound:e1");
  assert.equal(resolved.strategy, "exact-find");
  assert.ok(calls[0].includes("find"));
  assert.ok(calls[0].includes("--exact"));
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `node --test tests/core.test.js`

Expected: FAIL because `_resolveTargetDetailed` does not exist.

- [ ] **Step 3: Implement exact and contextual find**

For desktop targets with `app`, `role`, and `name`, build:

```js
["find", "--app", input.app, "--role", target.role, "--name", target.name, "--exact", "--timeout-ms", "5000"]
```

If `target.near` exists, first find `target.near`, then append `--root <near.ref>` to the target find. If the exact find reports not found, fall back to the existing compact snapshot matcher. Do not fall back after `AMBIGUOUS_TARGET`.

Return `{ ref, strategy: target.near ? "context-find" : "exact-find", path: match.path }`.

For browser targets with `selector`, return `{ ref: target.selector, strategy: "selector" }`
without taking a snapshot. Unique browser role/name targets continue through the
compact snapshot fallback because the browser backend exposes no observation-only
semantic find command.

Update `_resolveTarget` to return `_resolveTargetDetailed(...).ref`, preserving existing callers.

- [ ] **Step 4: Run all core tests**

Run: `node --test tests/core.test.js`

Expected: all PASS.

- [ ] **Step 5: Commit adaptive resolution**

```bash
git add src/index.js tests/core.test.js
git commit -m "feat: resolve semantic targets before snapshots"
```

### Task 4: JS API, CLI, and Single-Tool MCP

**Files:**
- Modify: `src/index.js`
- Modify: `src/cli.js`
- Modify: `src/mcp.js`
- Modify: `tests/mcp.test.js`
- Create: `examples/programs/browser-fill.json`

**Interfaces:**

- Consumes: Task 1-3 program types and `Computer.run`.
- Produces `Computer.saveProgram`, `Computer.listPrograms`, `Computer.getProgram`, `Computer.runProgram`.
- CLI commands: `program save`, `program list`, `program run`.
- MCP modes: `program_save`, `program_list`, `program_run`.

- [ ] **Step 1: Add a failing API integration test**

```js
test("Computer exposes semantic program methods", async () => {
  const computer = await createComputer({ session: "program-api-test" });
  assert.equal(typeof computer.saveProgram, "function");
  assert.equal(typeof computer.listPrograms, "function");
  assert.equal(typeof computer.getProgram, "function");
  assert.equal(typeof computer.runProgram, "function");
});
```

- [ ] **Step 2: Run API and MCP tests**

Run: `node --test tests/programs.test.js tests/mcp.test.js`

Expected: FAIL until the methods and protocol modes exist.

- [ ] **Step 3: Wire methods and protocol modes**

In `Computer`, construct:

```js
this.programStore = new ProgramStore({ directory: options.programDir });
this.programRuntime = new ProgramRuntime(this, this.programStore);
```

Delegate:

```js
saveProgram(definition) { return this.programStore.save(definition); }
listPrograms() { return this.programStore.list(); }
getProgram(name) { return this.programStore.get(name); }
runProgram(name, params = {}, options = {}) {
  return this.programRuntime.run(name, params, options);
}
```

Add CLI parsing:

```js
if (command === "program") {
  const [subcommand, value, params] = process.argv.slice(3);
  if (subcommand === "save") {
    const definition = existsSync(value)
      ? readFileSync(value, "utf8")
      : value;
    print(await computer.saveProgram(parseJsonArgument(definition, {})));
  }
  if (subcommand === "list") print(await computer.listPrograms());
  if (subcommand === "run") {
    print(await computer.runProgram(value, parseJsonArgument(params, {})));
  }
}
```

Extend the one MCP tool's `mode` enum and fields:

```json
{
  "mode": ["program_save", "program_list", "program_run"],
  "program": { "type": "object" },
  "programName": { "type": "string" },
  "params": { "type": "object" }
}
```

The existing `tools/list` response must still contain exactly one tool.

- [ ] **Step 4: Run tests and CLI smoke**

Run:

```bash
node --test tests/programs.test.js tests/mcp.test.js
node src/cli.js program list
```

Expected: tests PASS and CLI prints a JSON array.

- [ ] **Step 5: Commit public interfaces**

```bash
git add src/index.js src/cli.js src/mcp.js tests/mcp.test.js examples/programs/browser-fill.json
git commit -m "feat: expose semantic programs through js cli and mcp"
```

### Task 5: Live Replay, Benchmark, and 0.2.0 Release

**Files:**
- Modify: `tests/bench.js`
- Create: `scripts/smoke-program.mjs`
- Create: `examples/programs/cross-surface-observe.json`
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**

- Consumes: Task 1-4 complete program runtime.
- Produces: reproducible live smoke and model-payload benchmark.
- Package version: `0.2.0`.

- [ ] **Step 1: Add a failing model-payload benchmark assertion**

```js
const inlinePlan = JSON.stringify({
  mode: "run",
  steps: [
    { act: { surface: "browser", action: "fill", target: { role: "textbox", name: "Name" }, text: "Ada" } },
    { act: { surface: "browser", action: "click", target: { role: "button", name: "Save" } } }
  ]
});
const programCall = JSON.stringify({
  mode: "program_run",
  program: "browser.fill-and-save",
  params: { value: "Ada" }
});
assert.ok(Buffer.byteLength(programCall) < Buffer.byteLength(inlinePlan));
```

- [ ] **Step 2: Run benchmark and verify failure**

Run: `npm run bench`

Expected: FAIL or omission until benchmark fields are added.

- [ ] **Step 3: Implement browser and cross-surface live programs**

`browser-fill.json`:

```json
{
  "schema": "nexcore.program/v1",
  "name": "browser.fill",
  "version": "1.0.0",
  "description": "Fill a labeled browser field and verify its value.",
  "params": {
    "value": { "type": "string", "required": true }
  },
  "steps": [
    {
      "act": {
        "surface": "browser",
        "action": "open",
        "url": "data:text/html,<input aria-label=Name>"
      }
    },
    {
      "act": {
        "surface": "browser",
        "action": "fill",
        "target": { "role": "textbox", "name": "Name" },
        "text": "{{value}}",
        "expect": {
          "property": "value",
          "value": "{{value}}",
          "timeoutMs": 3000
        }
      }
    }
  ]
}
```

`cross-surface-observe.json` uses one browser `open` step and one desktop
`observe` step with `app: "{{app}}"` and `query: "{{query}}"`. It performs no
desktop action.

The live smoke script saves `browser-fill.json` into a temporary program
directory, runs it with `value: "--hello"`, asserts the result is `ok`, then
closes the controller and removes only the directory returned by
`mkdtempSync`.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run bench
npm run smoke:program
npm pack --dry-run
```

Expected:

- all Node tests PASS;
- benchmark prints both snapshot savings and program-call savings;
- live browser program fills `--hello` and verifies it;
- package dry-run includes program source, examples, docs, and no node_modules.

- [ ] **Step 5: Update release documentation and commit**

README must lead with:

> Compile once. Reuse across desktop and browser. One local call instead of
> replanning the same workflow on every run.

Document that screenshots/coordinates are never stored in programs, and that
program replay still obeys runtime policy.

```bash
git add .
git commit -m "feat: release semantic program runtime 0.2.0"
git push
```
