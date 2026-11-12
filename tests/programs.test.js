import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProgramRuntime,
  ProgramStore,
  compileProgram
} from "../src/programs.js";

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
