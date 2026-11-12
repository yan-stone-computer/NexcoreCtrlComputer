import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionPolicy,
  Computer,
  compactDesktopSnapshot,
  diffLines,
  estimateTokens,
  normalizeRefsForDiff
} from "../src/index.js";

const fixture = {
  app: "Calculator",
  snapshot_id: "sabc123",
  complete: true,
  tree: {
    role: "window",
    name: "Calculator",
    children: [
      {
        role: "group",
        children: [
          {
            ref_id: "@sabc123:e1",
            role: "textfield",
            name: "Display",
            value: "0",
            states: ["enabled"],
            available_actions: ["SetValue", "Focus"]
          },
          {
            ref_id: "@sabc123:e2",
            role: "button",
            name: "7",
            available_actions: ["Click"]
          }
        ]
      }
    ]
  }
};

test("desktop snapshots expose only the useful context and refs", () => {
  const compact = compactDesktopSnapshot(fixture, { interactiveOnly: true });
  assert.match(compact.text, /@sabc123:e1 textfield "Display" = "0"/);
  assert.match(compact.text, /@sabc123:e2 button "7" \[click\]/);
  assert.equal(compact.refs.length, 2);
  assert.ok(compact.text.length < JSON.stringify(fixture).length);
});

test("query narrows a snapshot without changing the ref", () => {
  const compact = compactDesktopSnapshot(fixture, { query: "7", interactiveOnly: true });
  assert.match(compact.text, /@sabc123:e2/);
  assert.doesNotMatch(compact.text, /Display/);
});

test("diff normalizes snapshot-qualified refs and reports only changes", () => {
  const before = "@sone:e1 button \"7\"\n@sone:e2 button \"8\"";
  const sameDesktop = "@stwo:e1 button \"7\"\n@stwo:e2 button \"8\"";
  const changed = "@stwo:e1 button \"7\"\n@stwo:e2 button \"9\"";
  assert.equal(normalizeRefsForDiff(before), normalizeRefsForDiff(sameDesktop));
  assert.equal(diffLines(normalizeRefsForDiff(before), normalizeRefsForDiff(sameDesktop)), "unchanged");
  assert.match(diffLines(normalizeRefsForDiff(before), normalizeRefsForDiff(changed)), /9/);
});

test("token estimate and safety policy fail closed", () => {
  assert.equal(estimateTokens("12345678"), 2);
  const policy = new ActionPolicy({ allowedApps: ["Calculator"], allowedDomains: ["example.com"] });
  assert.doesNotThrow(() => policy.checkApp("Calculator"));
  assert.throws(() => policy.checkApp("Terminal"), /allowedApps/);
  assert.doesNotThrow(() => policy.checkUrl("https://example.com/docs"));
  assert.throws(() => policy.checkUrl("https://evil.example/docs"), /allowedDomains/);
  assert.throws(() => policy.requireCoordinates(), /Coordinate control/);
  assert.throws(() => policy.requireHeaded("hover", true), /allowHeaded/);
});

test("desktop semantic targets use exact find before a snapshot", async () => {
  const computer = new Computer({ desktopBin: "unused" });
  const calls = [];
  computer._desktop = async (args) => {
    calls.push(args);
    return {
      data: {
        match: {
          ref_id: "@sfound:e1",
          role: "button",
          name: "7",
          path: ["window:Calculator", "button:7"]
        }
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

test("desktop contextual targets scope the target under a named ancestor", async () => {
  const computer = new Computer({ desktopBin: "unused" });
  const calls = [];
  computer._desktop = async (args) => {
    calls.push(args);
    const contextCall = calls.length === 2;
    return {
      data: {
        match: contextCall
          ? { ref_id: "@sfound:e2", role: "button", name: "Delete" }
          : { ref_id: "@sfound:e1", role: "row", name: "Invoice 42" }
      },
      elapsedMs: 1
    };
  };
  const resolved = await computer._resolveTargetDetailed({
    app: "Invoices",
    target: {
      role: "button",
      name: "Delete",
      near: { role: "row", name: "Invoice 42" }
    }
  }, "desktop");
  assert.equal(resolved.ref, "@sfound:e2");
  assert.equal(resolved.strategy, "context-find");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("--root"));
  assert.ok(calls[1].includes("@sfound:e1"));
});

test("browser selector targets bypass observation", async () => {
  const computer = new Computer({ desktopBin: "unused" });
  computer.observe = async () => {
    throw new Error("selector should not observe");
  };
  const resolved = await computer._resolveTargetDetailed({
    target: { selector: "#save" }
  }, "browser");
  assert.deepEqual(resolved, { ref: "#save", strategy: "selector" });
});

test("browser contextual targets fail closed instead of dropping context", async () => {
  const computer = new Computer({ desktopBin: "unused" });
  await assert.rejects(
    () => computer._resolveTargetDetailed({
      target: {
        role: "button",
        name: "Delete",
        near: { role: "row", name: "Invoice 42" }
      }
    }, "browser"),
    /contextual.*desktop/i
  );
});

test("run executes standalone verify steps", async () => {
  const computer = new Computer({ desktopBin: "unused" });
  computer.verify = async (payload) => ({ ok: true, property: payload.property, expected: payload.value });
  const results = await computer.run([
    { verify: { property: "value", value: "7" } }
  ]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].expected, "7");
});

test("exact find preserves an explicit first-match request", async () => {
  const computer = new Computer({ desktopBin: "unused" });
  let args;
  computer._desktop = async (value) => {
    args = value;
    return {
      data: { match: { ref_id: "@sfound:e1", role: "button", name: "7" } },
      elapsedMs: 1
    };
  };
  await computer._resolveTargetDetailed({
    app: "Calculator",
    target: { role: "button", name: "7", first: true }
  }, "desktop");
  assert.ok(args.includes("--first"));
});
