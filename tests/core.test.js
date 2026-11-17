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
import { WindowsMcpBridge } from "../src/windows-mcp.js";

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

test("desktop inventory views escape a previous browser session", async () => {
  const computer = new Computer({ desktopBin: "unused", browserBin: "unused" });
  const calls = [];
  computer._browser = async (args) => {
    calls.push(["browser", ...args]);
    return { data: { url: "https://example.com" }, elapsedMs: 1 };
  };
  computer._desktop = async (args) => {
    calls.push(["desktop", ...args]);
    return {
      data: [{ id: "w-calc", app_name: "CalculatorApp.exe", title: "Calculator" }],
      elapsedMs: 1
    };
  };

  await computer.act({ action: "open_url", url: "https://example.com" });
  const apps = await computer.observe({ view: "apps", delta: false });
  const windows = await computer.observe({ view: "windows", delta: false });

  assert.equal(apps.surface, "desktop");
  assert.equal(windows.surface, "desktop");
  assert.deepEqual(calls.slice(1).map((args) => args[1]), ["list-apps", "list-windows"]);
});

test("software inventory and adapter registry are separate from running apps", async () => {
  const computer = new Computer({ desktopBin: "unused", browserBin: "unused" });
  computer._installedApps = async () => [
    { name: "计算器", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", source: "StartMenu" },
    { name: "Visual Studio Code", appId: "Microsoft.VisualStudioCode", source: "StartMenu" }
  ];
  computer._commandExists = async (command) => command === "soffice"
    ? "C:\\Program Files\\LibreOffice\\soffice.exe"
    : null;

  const software = await computer.observe({ view: "software", query: "计算器", delta: false });
  const adapters = await computer.observe({ view: "adapters", delta: false });

  assert.equal(software.count, 1);
  assert.equal(software.items[0].launchAdapter, "windows-mcp");
  assert.deepEqual(software.items[0].launch, {
    adapter: "apps-folder",
    app: "计算器",
    appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"
  });
  assert.ok(software.items[0].controlAdapters.includes("agent-desktop"));
  assert.equal(adapters.view, "adapters");
  assert.match(adapters.text, /windows-mcp/i);
  assert.match(adapters.text, /libreoffice: available/);
});

test("catalog AUMID launches bypass desktop process-name guessing", async () => {
  const computer = new Computer({ desktopBin: "unused", browserBin: "unused" });
  let received = {};
  computer._launchSoftware = async input => {
    received = input;
    return {
      data: {
        success: true,
        text: "Opened shell:AppsFolder\\Chrome.Example",
        disposition: { delivery: "delivered_unverified", retry: "unsafe" }
      },
      elapsedMs: 0,
      engine: "windows-shell",
      strategy: "apps-folder"
    };
  };

  const opened = await computer.act({
    action: "open_app",
    app: "Google Chrome",
    appId: "Chrome.Example"
  });

  assert.equal(received.appId, "Chrome.Example");
  assert.equal(opened.receipt.route.engine, "windows-shell");
  assert.equal(opened.receipt.route.strategy, "apps-folder");
});

test("focused text and key sequences use Windows-MCP input", async () => {
  const computer = new Computer({ desktopBin: "unused", browserBin: "unused" });
  let focusedText = "";
  let sequence = [];
  computer.windowsMcp = {
    async typeAtFocus(text) {
      focusedText = text;
      return "pasted";
    },
    async pressSequence(keys) {
      sequence = keys;
      return "pressed";
    }
  };

  const typed = await computer.act({ action: "type", text: "NexcoreWork focused input" });
  const pressed = await computer.act({
    action: "press",
    keys: ["6", "4", "2", "*", "5", "3", "2", "="]
  });

  assert.equal(focusedText, "NexcoreWork focused input");
  assert.deepEqual(sequence, ["6", "4", "2", "*", "5", "3", "2", "="]);
  assert.equal(typed.receipt.route.strategy, "windows-mcp-focused-type");
  assert.equal(pressed.receipt.route.strategy, "windows-mcp-key-sequence");
});

test("modifier sequences are delivered as one chord while calculator keys stay sequential", async () => {
  const bridge = new WindowsMcpBridge({ enabled: true });
  const calls = [];
  bridge.call = async (name, args) => {
    calls.push({ name, args });
    return "ok";
  };

  await bridge.pressSequence(["CTRL", "V"]);
  assert.deepEqual(calls, [{ name: "Shortcut", args: { shortcut: "ctrl+v" } }]);

  calls.length = 0;
  await bridge.pressSequence(["6", "4", "2"]);
  assert.deepEqual(calls.map(call => call.args.shortcut), ["6", "4", "2"]);
});

test("browser observation includes the active page title", async () => {
  const computer = new Computer({ desktopBin: "unused", browserBin: "unused" });
  computer._browser = async (args) => {
    if (args[0] === "get" && args[1] === "title") {
      return { data: { title: "Example Domain" }, elapsedMs: 1 };
    }
    return {
      data: { snapshot: "- heading \"Example\"", refs: {}, url: "https://example.com/" },
      elapsedMs: 1
    };
  };

  const result = await computer.observe({ surface: "browser", open: false, delta: false });

  assert.equal(result.title, "Example Domain");
  assert.match(result.text, /title: Example Domain/);
});

test("Windows-MCP is the desktop fallback for observation, launch, and click", async () => {
  const computer = new Computer({ desktopBin: "unused", browserBin: "unused" });
  computer._desktop = async () => {
    throw Object.assign(new Error("agent-desktop unavailable"), { code: "BACKEND_ERROR" });
  };
  computer.windowsMcp = {
    async snapshot() {
      return {
        text: 'Opened Windows:\\n计算器   Normal  502  810  123',
        elements: [{ ref: "@wmcp:0", x: 116, y: 660, role: "按钮", name: "七" }]
      };
    },
    async launch() {
      return '{"pid":123}';
    },
    async element(ref) {
      return ref === "@wmcp:0" ? { x: 116, y: 660, role: "按钮", name: "七" } : null;
    },
    async click() {
      return "Single left clicked at (116,660).";
    }
  };

  const observed = await computer.observe({ view: "windows", delta: false });
  const opened = await computer.act({ action: "open_app", app: "Calculator" });
  const clicked = await computer.act({ action: "click", target: "@wmcp:0" });

  assert.equal(observed.surface, "desktop");
  assert.equal(observed.receipt.route.engine, "windows-mcp");
  assert.equal(observed.refs[0].ref, "@wmcp:0");
  assert.equal(opened.receipt.route.engine, "windows-mcp");
  assert.equal(clicked.receipt.route.strategy, "windows-mcp-click");
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
