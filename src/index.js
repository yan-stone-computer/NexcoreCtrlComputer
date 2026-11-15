import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProgramRuntime, ProgramStore } from "./programs.js";
import { WindowsMcpBridge } from "./windows-mcp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_BRIDGE = join(HERE, "..", "scripts", "pyautogui_bridge.py");
const RECEIPT_SCHEMA = "nexcore.control.receipt/v1";
const DESKTOP_VIEWS = Object.freeze({
  windows: "list-windows",
  displays: "list-displays",
  apps: "list-apps",
  notifications: "list-notifications",
  surfaces: "list-surfaces"
});
const WINDOW_ACTIONS = new Set([
  "window_focus",
  "window_resize",
  "window_move",
  "window_minimize",
  "window_maximize",
  "window_restore"
]);
const CLIPBOARD_FORMATS = new Set(["text", "auto", "image", "file-urls"]);
const DESKTOP_FALLBACK_CODES = new Set([
  "BACKEND_ERROR",
  "BACKEND_MISSING",
  "BRIDGE_MISSING",
  "PROCESS_ERROR",
  "TIMEOUT",
  "INVALID_OUTPUT",
  "ACTION_NOT_SUPPORTED"
]);
const ACTION_ALIASES = Object.freeze({
  open_app: "open",
  launch_app: "open",
  launch: "open",
  open_url: "open",
  navigate: "open",
  goto: "open",
  set_value: "fill",
  click_element: "click",
  type_text: "type",
  key: "press",
  press_key: "press",
  close_window: "close_app",
  focus_window: "window_focus",
  resize_window: "window_resize",
  move_window: "window_move",
  minimize_window: "window_minimize",
  maximize_window: "window_maximize",
  restore_window: "window_restore",
  verify: "verify"
});

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

function canUseWindowsMcpFallback(error) {
  return DESKTOP_FALLBACK_CODES.has(String(error?.code || ""));
}

function controlReceipt(operation, {
  surface,
  engine,
  strategy = "semantic",
  delivery = "not_delivered",
  retry = "unsafe",
  verified = false,
  revision,
  complete = true
} = {}) {
  return {
    schema: RECEIPT_SCHEMA,
    operation,
    route: { surface, engine, strategy },
    effect: { delivery, retry },
    evidence: {
      ...(revision ? { revision } : {}),
      complete,
      verified
    }
  };
}

function actionResult(surface, action, data, extra = {}) {
  const disposition = data?.disposition || data?.result?.disposition || {};
  const delivery = disposition.delivery || (data?.success === false ? "not_delivered" : "delivered");
  const retry = disposition.retry || "unsafe";
  const strategy = extra.strategy || extra.resolution?.strategy || "semantic";
  const result = {
    surface,
    action,
    delivery,
    retry,
    ...extra
  };
  result.receipt = controlReceipt("act", {
    surface,
    engine: surface === "browser" ? "browser" : "desktop",
    strategy,
    delivery,
    retry,
    verified: Boolean(
      extra.verification?.ok
      || delivery === "delivered_verified"
      || delivery === "verified"
    )
  });
  return result;
}

function numericWindowValue(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new NexcoreError("INVALID_WINDOW_VALUE", `${name} must be an integer from ${min} to ${max}.`, {
      details: { field: name, value },
      retry: "safe"
    });
  }
  return number;
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
    this.policy = options.policy instanceof ActionPolicy
      ? options.policy
      : new ActionPolicy(options.policy || options);
    this.programStore = new ProgramStore({ directory: options.programDir });
    this.programRuntime = new ProgramRuntime(this, this.programStore);
    this.windowsMcp = new WindowsMcpBridge(options.windowsMcp || {});
    this.previous = new Map();
    this.activeSurface = "desktop";
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
    const [desktop, browser, pyautogui, windowsMcp] = await Promise.all([
      probe("desktop", this.config.desktopBin, ["status"]),
      probe("browser", this.config.browserBin, ["--json", "doctor"]),
      this._pyautogui({ action: "status" }).then(
        (data) => ({ name: "pyautogui", ok: true, data }),
        (error) => ({ name: "pyautogui", ok: false, code: error.code, message: error.message })
      ),
      this.windowsMcp.probe()
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
      ok: (desktop.ok || windowsMcp.ok) && browser.ok,
      kernel: {
        schema: RECEIPT_SCHEMA,
        pipeline: ["observe", "resolve", "act", "verify", "receipt"],
        policy: "semantic-first"
      },
      capabilities: {
        observe: ["semantic", "windows", "displays", "apps", "notifications", "surfaces", "browser"],
        act: [
          "open", "click", "double_click", "right_click", "hover", "focus", "fill", "type",
          "press", "select", "check", "uncheck", "toggle", "expand", "collapse", "scroll",
          "screenshot", "close_app", "window_focus", "window_resize", "window_move", "window_minimize",
          "window_maximize", "window_restore", "clipboard_get", "clipboard_set", "clipboard_clear"
        ],
        verify: ["value", "text", "title", "url", "html", "exists"],
        safeguards: ["approval", "allowed-apps", "allowed-domains", "semantic-refs", "retry-disposition"]
      },
      routes: [
        {
          route: "semantic-desktop",
          state: desktop.ok ? "ready" : "unavailable",
          detail: desktopSummary
        },
        {
          route: "browser",
          state: browserSummary.ok ? "ready" : "unavailable",
          detail: browserSummary
        },
        {
          route: "windows-mcp",
          state: windowsMcp.ok ? "ready" : "unavailable",
          detail: windowsMcp
        },
        {
          route: "coordinate-fallback",
          state: pyautogui.ok && this.policy.allowCoordinates ? "enabled" : pyautogui.ok ? "policy-disabled" : "unavailable",
          detail: pyautogui
        }
      ],
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

  _windowArgs(input, { title = false } = {}) {
    const args = [];
    const app = input.app ? String(input.app) : "";
    const windowId = input.windowId ?? input.window_id;
    const windowTitle = input.windowTitle ?? input.window_title ?? (title ? input.title : undefined);
    if (app) {
      this.policy.checkApp(app);
      args.push("--app", app);
    }
    if (windowId !== undefined && windowId !== null && String(windowId).trim()) {
      args.push("--window-id", String(windowId).trim());
    }
    if (title && windowTitle !== undefined && String(windowTitle).trim()) {
      args.push("--title", String(windowTitle).trim());
    }
    if (!args.length) {
      throw new NexcoreError("WINDOW_REQUIRED", "This window action needs app, windowId, or windowTitle.", {
        retry: "safe"
      });
    }
    return args;
  }

  async _desktopView(input) {
    const view = String(input.view || "");
    const command = DESKTOP_VIEWS[view];
    if (!command) {
      throw new NexcoreError("INVALID_VIEW", `Unknown desktop view: ${view}`, {
        details: { supported: Object.keys(DESKTOP_VIEWS) },
        retry: "safe"
      });
    }
    if (input.app) {
      input = { ...input, app: this._canonicalApp(input, "observe") };
      this.policy.checkApp(input.app);
    }
    const args = [command];
    if (input.app) args.push("--app", String(input.app));
    if (view === "surfaces" && !input.app) {
      const windowId = input.windowId ?? input.window_id;
      const windowTitle = input.windowTitle ?? input.window_title ?? input.title;
      if (!windowId && !windowTitle) {
        throw new NexcoreError("APP_REQUIRED", "The surfaces view needs app, windowId, or windowTitle.", { retry: "safe" });
      }
      const windows = await this._desktop(["list-windows"]);
      const rows = Array.isArray(windows.data) ? windows.data : windows.data?.windows || [];
      const matches = rows.filter(item =>
        (windowId && String(item.id) === String(windowId))
        || (windowTitle && String(item.title || "").includes(String(windowTitle)))
      );
      if (matches.length !== 1) {
        throw new NexcoreError(
          matches.length ? "AMBIGUOUS_WINDOW" : "WINDOW_NOT_FOUND",
          matches.length ? "More than one window matched the surfaces selector." : "No window matched the surfaces selector.",
          { details: { windowId, windowTitle, matches: matches.slice(0, 8) }, retry: "safe" }
        );
      }
      const app = String(matches[0].app_name || matches[0].process_name || "");
      if (!app) throw new NexcoreError("APP_NOT_FOUND", "The selected window has no process identity.", { retry: "safe" });
      this.policy.checkApp(app);
      args.push("--app", app);
    }
    if (view === "notifications") {
      if (input.query) args.push("--text", String(input.query));
      if (input.limit) args.push("--limit", String(Math.max(1, Math.min(100, Number(input.limit) || 20))));
    }
    const response = await this._desktop(args);
    const raw = response.data;
    let items = Array.isArray(raw)
      ? raw
      : ["items", "windows", "displays", "apps", "notifications", "surfaces"]
          .map(key => raw?.[key])
          .find(Array.isArray) || [];
    /**
     * UWP 窗口可能由 ApplicationFrameHost 持有，list-apps 会对用户看到的进程名返回空。
     * windows 视图仍能给出窗口真实 app_name；筛选 apps 时用同一身份补一条应用记录。
     */
    if (view === "apps" && input.app && items.length === 0) {
      const windows = await this._desktop(["list-windows", "--app", String(input.app)]);
      const windowRows = Array.isArray(windows.data) ? windows.data : windows.data?.windows || [];
      if (windowRows.length) {
        items = [{
          name: String(input.app),
          windowCount: windowRows.length,
          pids: [...new Set(windowRows.map(item => item.pid).filter(Number.isFinite))],
          windows: windowRows.map(item => ({ id: item.id, title: item.title, pid: item.pid, bounds: item.bounds }))
        }];
      }
    }
    const query = String(input.query || "").toLocaleLowerCase();
    const filtered = (query && view !== "notifications"
      ? items.filter(item => JSON.stringify(item).toLocaleLowerCase().includes(query))
      : items
    ).slice(0, Math.max(1, Math.min(100, Number(input.maxItems) || 40)));
    const text = filtered.length
      ? filtered.map((item, index) => `${index + 1}. ${truncate(JSON.stringify(item), 220)}`).join("\n")
      : `(no ${view})`;
    const key = ["view", this.config.session, view, input.app || "", query, input.maxItems || ""].join(":");
    const remembered = this._remember(key, text);
    const output = input.delta !== false && remembered.previous ? diffLines(remembered.previous.text, text) : text;
    return {
      surface: "desktop",
      view,
      count: filtered.length,
      total: items.length,
      complete: true,
      text: output,
      items: filtered,
      revision: remembered.revision,
      elapsedMs: response.elapsedMs,
      receipt: controlReceipt("observe", {
        surface: "desktop",
        engine: "windows",
        strategy: view,
        delivery: "observed",
        retry: "safe",
        verified: true,
        revision: remembered.revision
      })
    };
  }

  async _windowsMcpObserve(input) {
    const view = String(input.view || "semantic");
    const snapshot = await this.windowsMcp.snapshot({
      useUiTree: true,
      useVision: false
    });
    const maxChars = input.maxChars ?? this.config.maxChars;
    const text = snapshot.text.length > maxChars
      ? `${snapshot.text.slice(0, maxChars - 20)}\n… output capped`
      : snapshot.text;
    const key = ["windows-mcp", this.config.session, view, input.query || "", input.maxItems || ""].join(":");
    const remembered = this._remember(key, text);
    const output = input.delta !== false && remembered.previous
      ? diffLines(remembered.previous.text, text)
      : text;
    return {
      surface: "desktop",
      view,
      count: snapshot.elements.length,
      total: snapshot.elements.length,
      complete: false,
      text: output,
      refs: snapshot.elements,
      revision: remembered.revision,
      receipt: controlReceipt("observe", {
        surface: "desktop",
        engine: "windows-mcp",
        strategy: `${view}-fallback`,
        delivery: "observed",
        retry: "safe",
        verified: true,
        revision: remembered.revision,
        complete: false
      })
    };
  }

  async _windowApp(input) {
    if (input.app) {
      const app = this._canonicalApp(input, input.action || "observe");
      this.policy.checkApp(app);
      return app;
    }
    const windowId = input.windowId ?? input.window_id;
    const windowTitle = input.windowTitle ?? input.window_title ?? input.title;
    const focused = ["focused", "active"].includes(String(input.surface || "").toLocaleLowerCase());
    if (!windowId && !windowTitle && !focused) return "";
    const windows = await this._desktop(["list-windows"]);
    const rows = Array.isArray(windows.data) ? windows.data : windows.data?.windows || [];
    const matches = rows.filter(item =>
      (windowId && String(item.id) === String(windowId))
      || (windowTitle && String(item.title || "").includes(String(windowTitle)))
      || (focused && item.is_focused === true)
    );
    if (matches.length !== 1) {
      throw new NexcoreError(
        matches.length ? "AMBIGUOUS_WINDOW" : "WINDOW_NOT_FOUND",
        matches.length ? "More than one window matched the semantic observer." : "No window matched the semantic observer.",
        { details: { windowId, windowTitle, focused, matches: matches.slice(0, 8) }, retry: "safe" }
      );
    }
    const app = this._canonicalApp({ app: String(matches[0].app_name || matches[0].process_name || "") }, input.action || "observe");
    if (!app) throw new NexcoreError("APP_NOT_FOUND", "The selected window has no process identity.", { retry: "safe" });
    this.policy.checkApp(app);
    return app;
  }

  _canonicalApp(input = {}, action = "") {
    const raw = String(input.app || "").trim();
    if (!raw) return "";
    const key = raw.toLocaleLowerCase();
    const aliases = {
      edge: "msedge.exe",
      "microsoft edge": "msedge.exe",
      chrome: "chrome.exe",
      "google chrome": "chrome.exe",
      firefox: "firefox.exe",
      notepad: "notepad.exe",
      "记事本": "notepad.exe",
      explorer: "explorer.exe",
      "file explorer": "explorer.exe",
      "文件资源管理器": "explorer.exe",
      calculator: "CalculatorApp.exe",
      calc: "CalculatorApp.exe",
      "计算器": "CalculatorApp.exe"
    };
    let app = aliases[key] || raw;
    if (action === "open") {
      const candidates = {
        "CalculatorApp.exe": ["C:\\Windows\\System32\\calc.exe"],
        "msedge.exe": [
          join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
          join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe")
        ],
        "chrome.exe": [
          join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
        ],
        "notepad.exe": [join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe")]
      }[app] || [];
      app = candidates.find(candidate => candidate && existsSync(candidate)) || app;
    }
    return app;
  }

  async _windowAction(input, action) {
    const commands = {
      window_focus: "focus-window",
      window_resize: "resize-window",
      window_move: "move-window",
      window_minimize: "minimize",
      window_maximize: "maximize",
      window_restore: "restore"
    };
    const args = [commands[action], ...this._windowArgs(input, { title: action === "window_focus" })];
    if (action === "window_resize") {
      args.push(
        "--width",
        String(numericWindowValue(input.width, "width", 100, 10000)),
        "--height",
        String(numericWindowValue(input.height, "height", 100, 10000))
      );
    } else if (action === "window_move") {
      args.push(
        "--x",
        String(numericWindowValue(input.x, "x", -100000, 100000)),
        "--y",
        String(numericWindowValue(input.y, "y", -100000, 100000))
      );
    }
    if (action === "window_focus") {
      const windows = await this._desktop(["list-windows"]);
      const rows = Array.isArray(windows.data) ? windows.data : windows.data?.windows || [];
      const windowId = input.windowId ?? input.window_id;
      const windowTitle = input.windowTitle ?? input.window_title ?? input.title;
      const app = input.app ? String(input.app) : "";
      const target = rows.find(item =>
        (windowId && String(item.id) === String(windowId))
        || (windowTitle && String(item.title || "").includes(String(windowTitle)))
        || (!windowId && !windowTitle && app && String(item.app_name || item.process_name || "").toLocaleLowerCase() === app.toLocaleLowerCase())
      );
      const robustArgs = ["focus-window"];
      if (target?.app_name) robustArgs.push("--app", String(target.app_name));
      if (target?.id) robustArgs.push("--window-id", String(target.id));
      if (target?.title) robustArgs.push("--title", String(target.title));
      const focusArgs = robustArgs.length > 1 ? robustArgs : args;
      if (target?.minimized) await this._desktop(["restore", "--window-id", target.id], { headed: true });
      try {
        const response = await this._desktop(focusArgs);
        return actionResult("desktop", action, response.data, {
          window: input.windowId ?? input.window_id ?? target?.id ?? null,
          strategy: "native-window",
          elapsedMs: response.elapsedMs
        });
      } catch (firstError) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
        if (target?.id) await this._desktop(["restore", "--window-id", target.id], { headed: true }).catch(() => {});
        try {
          const response = await this._desktop(focusArgs);
          return actionResult("desktop", action, response.data, {
            window: input.windowId ?? input.window_id ?? target?.id ?? null,
            strategy: "native-window-retry",
            elapsedMs: response.elapsedMs + 250,
            retryAfter: firstError.code || "ACTION_FAILED"
          });
        } catch (secondError) {
          if (!this.policy.allowHeaded || !target?.bounds) throw secondError;
          const bounds = target.bounds;
          const x = Math.round(Number(bounds.x) + Number(bounds.width) / 2);
          const y = Math.round(Number(bounds.y) + 12);
          try {
            await this._pyautogui({ action: "click", x, y, timeoutMs: this.config.timeoutMs });
          } catch {
            await this._desktop(["mouse-click", "--xy", `${x},${y}`], { headed: true });
          }
          await new Promise(resolvePromise => setTimeout(resolvePromise, 180));
          const after = await this._desktop(["list-windows"]);
          const afterRows = Array.isArray(after.data) ? after.data : after.data?.windows || [];
          const focused = afterRows.find(item => String(item.id) === String(target.id));
          if (!focused?.is_focused) throw secondError;
          return {
            surface: "desktop",
            action,
            delivery: "delivered_verified",
            retry: "unsafe",
            window: target.id,
            focused,
            receipt: controlReceipt("act", {
              surface: "desktop",
              engine: "windows",
              strategy: "titlebar-focus",
              delivery: "delivered_verified",
              retry: "unsafe",
              verified: true
            })
          };
        }
      }
    }
    const response = await this._desktop(args);
    return actionResult("desktop", action, response.data, {
      window: input.windowId ?? input.window_id ?? null,
      strategy: "native-window",
      elapsedMs: response.elapsedMs
    });
  }

  async _clipboardAction(input, action) {
    if (action === "clipboard_get") {
      const format = String(input.format || "text");
      if (!CLIPBOARD_FORMATS.has(format)) {
        throw new NexcoreError("INVALID_CLIPBOARD_FORMAT", `Unknown clipboard format: ${format}`, {
          details: { supported: [...CLIPBOARD_FORMATS] },
          retry: "safe"
        });
      }
      const response = await this._desktop(["clipboard-get", "--format", format]);
      return actionResult("desktop", action, response.data, {
        format,
        strategy: "native-clipboard",
        elapsedMs: response.elapsedMs
      });
    }
    if (action === "clipboard_set") {
      const value = String(input.text ?? input.value ?? "");
      if (Buffer.byteLength(value, "utf8") > 128 * 1024) {
        throw new NexcoreError("CLIPBOARD_TOO_LARGE", "Clipboard text is limited to 128 KiB.", {
          retry: "safe"
        });
      }
      const response = await this._desktop(["clipboard-set", "--stdin"], { input: value });
      return actionResult("desktop", action, response.data, {
        bytes: Buffer.byteLength(value, "utf8"),
        strategy: "native-clipboard",
        elapsedMs: response.elapsedMs
      });
    }
    const response = await this._desktop(["clipboard-clear"]);
    return actionResult("desktop", action, response.data, {
      strategy: "native-clipboard",
      elapsedMs: response.elapsedMs
    });
  }

  _surface(input) {
    const action = String(input.action || "").toLocaleLowerCase();
    const view = String(input.view || "").toLocaleLowerCase();
    const windowId = input.windowId ?? input.window_id;
    const windowTitle = input.windowTitle ?? input.window_title ?? input.title;
    const ref = typeof input.target === "string" ? input.target : input.target?.ref || input.ref;
    const browserAction = ["open_url", "navigate", "goto"].includes(action);
    const desktopAction = WINDOW_ACTIONS.has(action)
      || ["open_app", "launch_app", "launch", "close_app", "close_window"].includes(action)
      || action.startsWith("clipboard_")
      || /^@live:/i.test(String(ref || ""));
    let surface;
    if (input.surface === "desktop" || input.surface === "browser") {
      surface = input.surface;
    } else if (input.url || browserAction || (input.target?.selector && !windowId)) {
      surface = "browser";
    } else if (
      DESKTOP_VIEWS[view]
      || ["semantic", "window", "tree", "accessibility"].includes(view)
      || input.app
      || windowId
      || windowTitle
      || ["focused", "active"].includes(String(input.surface || "").toLocaleLowerCase())
      || desktopAction
    ) {
      surface = "desktop";
    } else if (this.activeSurface === "browser") {
      surface = "browser";
    } else {
      surface = "desktop";
    }
    this.activeSurface = surface;
    return surface;
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
    const requestedView = String(input.view || "").toLocaleLowerCase();
    const windowId = input.windowId ?? input.window_id;
    const windowTitle = input.windowTitle ?? input.window_title ?? input.title;
    const focusedSurface = ["focused", "active"].includes(String(input.surface || "").toLocaleLowerCase());
    const semanticAlias = ["semantic", "window", "tree", "accessibility"].includes(requestedView)
      || (["apps", "surfaces"].includes(requestedView) && Boolean(windowId || windowTitle || focusedSurface));
    if (surface === "desktop" && semanticAlias) {
      const app = input.app || await this._windowApp({ ...input, view: requestedView });
      input = {
        ...input,
        app,
        view: undefined,
        surfaceKind: input.surfaceKind || (focusedSurface ? "focused" : input.surface)
      };
    }
    if (surface === "desktop" && input.view) {
      try {
        const viewed = await this._desktopView(input);
        viewed.bytes = Buffer.byteLength(viewed.text, "utf8");
        viewed.estimatedTokens = estimateTokens(viewed.text);
        return viewed;
      } catch (error) {
        if (!canUseWindowsMcpFallback(error)) throw error;
        try {
          const viewed = await this._windowsMcpObserve(input);
          viewed.bytes = Buffer.byteLength(viewed.text, "utf8");
          viewed.estimatedTokens = estimateTokens(viewed.text);
          return viewed;
        } catch {
          throw error;
        }
      }
    }
    const delta = input.delta !== false;
    const key = [
      surface,
      this.config.session,
      input.app || input.url || input.root || "active",
      input.query || "",
      input.selector || "",
      input.depth || "",
      input.maxNodes || "",
      input.interactiveOnly !== false,
      input.view || ""
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
      let response;
      try {
        response = await this._desktop(args);
      } catch (error) {
        if (!canUseWindowsMcpFallback(error)) throw error;
        return this._windowsMcpObserve({
          ...input,
          view: input.view || "semantic"
        });
      }
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
        elapsedMs: response.elapsedMs,
        receipt: controlReceipt("observe", {
          surface,
          engine: "desktop",
          strategy: "accessibility",
          delivery: "observed",
          retry: "safe",
          verified: true,
          revision: remembered.revision,
          complete: response.data.complete !== false
        })
      };
    } else if (surface === "browser") {
      this.policy.checkUrl(input.url);
      if (input.url && input.open !== false) {
        await this._browser(["open", input.url]);
      }
      const args = input.selector ? ["snapshot", "-c"] : ["snapshot", "-i", "-c"];
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
        elapsedMs: response.elapsedMs,
        receipt: controlReceipt("observe", {
          surface,
          engine: "browser",
          strategy: "accessibility",
          delivery: "observed",
          retry: "safe",
          verified: true,
          revision: remembered.revision
        })
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
    if (target.first) args.push("--first");
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
    if (typeof input.target?.ref === "string" && input.target.ref.startsWith("@")) {
      return { ref: input.target.ref, strategy: "provided-ref" };
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

  async _windowsMcpAction(input, action, ref) {
    if (action === "press") {
      const text = await this.windowsMcp.press(input.keys);
      return actionResult("desktop", action, {
        success: true,
        text,
        disposition: { delivery: "delivered", retry: "unsafe" }
      }, { ref, strategy: "windows-mcp-shortcut" });
    }
    const element = Number.isFinite(input.target?.x) && Number.isFinite(input.target?.y)
      ? { x: input.target.x, y: input.target.y }
      : this.windowsMcp.element(ref);
    if (!element) {
      throw new NexcoreError("TARGET_NOT_FOUND", `Windows-MCP element is no longer available: ${ref}`, {
        retry: "safe"
      });
    }
    let text;
    let strategy = "windows-mcp-click";
    if (action === "click" || action === "check" || action === "uncheck" || action === "toggle"
      || action === "expand" || action === "collapse" || action === "focus" || action === "select") {
      text = await this.windowsMcp.click(element, 1);
    } else if (action === "double_click") {
      text = await this.windowsMcp.click(element, 2);
    } else if (action === "right_click") {
      text = await this.windowsMcp.call("Click", {
        loc: [element.x, element.y],
        button: "right",
        clicks: 1
      });
    } else if (action === "hover") {
      text = await this.windowsMcp.click(element, 0);
    } else if (action === "fill" || action === "type") {
      text = await this.windowsMcp.type(element, input.text ?? input.value ?? "", {
        clear: action === "fill"
      });
      strategy = "windows-mcp-type";
    } else if (action === "scroll") {
      text = await this.windowsMcp.scroll(element, input.direction || "down", input.amount || 3);
      strategy = "windows-mcp-scroll";
    } else {
      throw new NexcoreError("ACTION_NOT_SUPPORTED", `Windows-MCP fallback does not support ${action}.`, {
        retry: "safe"
      });
    }
    return actionResult("desktop", action, {
      success: true,
      text,
      disposition: { delivery: "delivered", retry: "unsafe" }
    }, { ref, strategy });
  }

  async act(input = {}) {
    this._ensureOpen();
    const surface = this._surface(input);
    let action = ACTION_ALIASES[String(input.action || "").toLocaleLowerCase()] || input.action;
    if (!action) throw new NexcoreError("ACTION_REQUIRED", "action is required.", { retry: "safe" });
    if (action === "focus" && (input.target?.role === "window" || input.windowId || input.window_id || input.windowTitle || input.window_title)) {
      action = "window_focus";
      input = { ...input, ...(input.target?.role === "window" && input.target.name ? { windowTitle: input.target.name } : {}) };
      if (input.target?.role === "window") delete input.target;
    }
    if (action === "verify") {
      return this.verify({ ...input, action: undefined });
    }
    if (action === "press" && input.key !== undefined && input.keys === undefined) input = { ...input, keys: input.key };
    input = { ...input, action };
    if (action === "open" && !input.app && typeof input.target === "string" && !input.target.startsWith("@")) input.app = input.target;
    if (action === "open" && !input.app && input.target?.name && !input.target.ref && !input.target.selector) input.app = input.target.name;
    if (input.app) {
      input.app = this._canonicalApp(input, action);
      this.policy.checkApp(input.app);
    }
    this.policy.requireHeaded(action, input.headed);

    if (action === "coordinate_click") {
      this.policy.requireCoordinates();
      const target = input.target;
      if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
        throw new NexcoreError("TARGET_REQUIRED", "coordinate_click needs {x,y}.", { retry: "safe" });
      }
      const data = await this._pyautogui({ action: "click", x: target.x, y: target.y, timeoutMs: this.config.timeoutMs });
      return {
        surface: "coordinate",
        action,
        delivery: "delivered_unverified",
        retry: "unsafe",
        data,
        receipt: controlReceipt("act", {
          surface: "desktop",
          engine: "coordinate",
          strategy: "explicit-coordinate",
          delivery: "delivered_unverified",
          retry: "unsafe"
        })
      };
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
      const requestedTimeout = Number(input.timeoutMs);
      const launchTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 10000;
      let response;
      let launchEngine = "windows";
      try {
        response = await this._desktop([
          "launch",
          input.app,
          "--timeout",
          String(Math.min(launchTimeout, this.config.timeoutMs))
        ], { headed: input.headed });
      } catch (error) {
        if (!canUseWindowsMcpFallback(error)) throw error;
        const text = await this.windowsMcp.launch(input.app, input.app);
        launchEngine = "windows-mcp";
        response = {
          data: {
            success: true,
            text,
            disposition: { delivery: "delivered_unverified", retry: "unsafe" }
          },
          elapsedMs: 0
        };
      }
      return {
        ...actionResult("desktop", action, response.data, { elapsedMs: response.elapsedMs }),
        delivery: "delivered_unverified",
        window: "unverified",
        receipt: controlReceipt("act", {
          surface: "desktop",
          engine: launchEngine,
          strategy: launchEngine === "windows-mcp" ? "app-launch-fallback" : "process-launch",
          delivery: "delivered_unverified",
          retry: "unsafe"
        })
      };
    }

    if (action === "screenshot") {
      const path = input.path || defaultScreenshotPath(`nexcore-${Date.now()}.png`);
      const response = surface === "desktop"
        ? await this._desktop(["screenshot", path, ...(input.app ? ["--app", input.app] : [])], { headed: input.headed })
        : await this._browser(["screenshot", path], { headed: input.headed });
      return actionResult(surface, action, response.data, { path, elapsedMs: response.elapsedMs });
    }

    if (action === "close_app") {
      if (surface !== "desktop") {
        throw new NexcoreError("INVALID_SURFACE", "close_app is only available on the desktop surface.", {
          retry: "safe"
        });
      }
      if (!input.app) throw new NexcoreError("APP_REQUIRED", "close_app needs app.", { retry: "safe" });
      this.policy.checkApp(input.app);
      const args = ["close-app", String(input.app)];
      if (input.force === true) args.push("--force");
      const response = await this._desktop(args);
      return actionResult("desktop", action, response.data, {
        strategy: "native-process",
        elapsedMs: response.elapsedMs
      });
    }

    if (WINDOW_ACTIONS.has(action)) {
      if (surface !== "desktop") {
        throw new NexcoreError("INVALID_SURFACE", `${action} is only available on the desktop surface.`, {
          retry: "safe"
        });
      }
      return this._windowAction(input, action);
    }

    if (action === "clipboard_get" || action === "clipboard_set" || action === "clipboard_clear") {
      if (surface !== "desktop") {
        throw new NexcoreError("INVALID_SURFACE", `${action} is only available on the desktop surface.`, {
          retry: "safe"
        });
      }
      return this._clipboardAction(input, action);
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
      if (String(ref || "").startsWith("@wmcp:")) {
        const result = await this._windowsMcpAction(input, action, ref);
        if (input.expect) {
          const expectation = { ...input.expect, surface, ref };
          result.verification = await this.verify(expectation);
          if (result.verification?.ok) result.delivery = "delivered_verified";
          result.receipt.effect.delivery = result.delivery;
          result.receipt.evidence.verified = Boolean(result.verification?.ok);
        }
        return result;
      }
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
    if (input.expect) {
      const expectation = { ...input.expect, surface, app: input.app, url: input.url };
      if (!input.expect.ref && !input.expect.target) expectation.ref = ref;
      result.verification = await this.verify(expectation);
    }
    if (result.verification?.ok) result.delivery = "delivered_verified";
    result.receipt.evidence.verified = Boolean(result.verification?.ok);
    result.receipt.effect.delivery = result.delivery;
    result.receipt.effect.retry = result.retry;
    return result;
  }

  async verify(expect = {}) {
    this._ensureOpen();
    const surface = expect.surface || "desktop";
    const requestedProperty = expect.property || "value";
    const property = requestedProperty === "name" ? "text" : requestedProperty;
    const expected = String(expect.value ?? (property === "exists" ? expect.target?.name ?? "" : ""));
    const timeoutMs = expect.timeoutMs || this.config.verifyTimeoutMs;
    const ref = property === "url" ? null : expect.ref || await this._resolveTarget(
      { ...expect, target: expect.target },
      surface
    );

    if (surface === "desktop") {
      if (String(ref || "").startsWith("@wmcp:")) {
        const needle = expected || expect.target?.name || "";
        try {
          const text = await this.windowsMcp.waitForText(needle, timeoutMs);
          return {
            ok: true,
            ref,
            property,
            expected: needle,
            observed: { text },
            receipt: controlReceipt("verify", {
              surface,
              engine: "windows-mcp",
              strategy: "wait-for-text",
              delivery: "verified",
              retry: "safe",
              verified: true
            })
          };
        } catch (error) {
          throw new NexcoreError("VERIFY_TIMEOUT", `Expected ${property}=${needle}; Windows-MCP did not observe it.`, {
            details: { ref, cause: error instanceof Error ? error.message : String(error) },
            retry: "unsafe"
          });
        }
      }
      if (property === "text" || property === "title") {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() <= deadline) {
          const response = await this._desktop(["get", "--property", property, ref]);
          last = response.data;
          const observed = typeof last === "string"
            ? last
            : String(last?.text ?? last?.title ?? last?.value ?? last?.result ?? "");
          if (observed.trim() === expected.trim()) {
            return {
              ok: true,
              ref,
              property,
              expected,
              observed: last,
              receipt: controlReceipt("verify", {
                surface,
                engine: "desktop",
                strategy: property,
                delivery: "verified",
                retry: "safe",
                verified: true
              })
            };
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
        }
        throw new NexcoreError("VERIFY_TIMEOUT", `Expected ${property}=${expected}; last value did not match.`, {
          details: { ref, last },
          retry: "unsafe"
        });
      }
      const predicate = property === "value" ? "value" : property;
      const args = [
        "wait",
        "--element",
        ref,
        "--predicate",
        predicate,
        "--timeout",
        String(timeoutMs)
      ];
      if (predicate === "value") args.push("--value", expected);
      const response = await this._desktop(args);
      const ok = response.data.found === true;
      return {
        ok,
        ref,
        property,
        expected,
        observed: {
          ...(response.data.observed || {}),
          ...(property === "exists" && expect.target?.name ? { target_name: expect.target.name, matched: ok } : {})
        },
        receipt: controlReceipt("verify", {
          surface,
          engine: "desktop",
          strategy: property,
          delivery: ok ? "verified" : "unverified",
          retry: ok ? "safe" : "unsafe",
          verified: ok
        })
      };
    }

    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() <= deadline) {
      const response = property === "url" || property === "title"
        ? await this._browser(["get", property])
        : property === "exists"
          ? await this._browser(["get", "count", ref])
          : await this._browser(["get", property, ref]);
      last = response.data;
      const observed = property === "exists"
        ? Number(last?.count ?? last ?? 0) > 0
        : String(last?.url ?? last?.text ?? last?.value ?? last?.title ?? last?.html ?? last?.result ?? last ?? "");
      if (property === "exists" ? observed : observed === expected) {
        return {
          ok: true,
          ref,
          property,
          expected,
          observed: last,
          receipt: controlReceipt("verify", {
            surface,
            engine: "browser",
            strategy: property,
            delivery: "verified",
            retry: "safe",
            verified: true
          })
        };
      }
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
        const mode = step.mode || (
          step.observe ? "observe" :
          step.act ? "act" :
          step.verify ? "verify" :
          step.action ? "act" :
          null
        );
        const payload = step.observe || step.act || step.verify || step;
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

  saveProgram(definition) {
    this._ensureOpen();
    return this.programStore.save(definition);
  }

  listPrograms() {
    this._ensureOpen();
    return this.programStore.list();
  }

  getProgram(name) {
    this._ensureOpen();
    return this.programStore.get(name);
  }

  runProgram(name, params = {}, options = {}) {
    this._ensureOpen();
    return this.programRuntime.run(name, params);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([
      this.windowsMcp.close(),
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
