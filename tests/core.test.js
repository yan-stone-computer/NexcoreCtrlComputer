import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionPolicy,
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
