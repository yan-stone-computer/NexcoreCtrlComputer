function textContent(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item) => item?.type === "text")
    .flatMap((item) => {
      const raw = String(item.text || "");
      try {
        const value = JSON.parse(raw);
        if (Array.isArray(value)) {
          return value.filter((entry) => typeof entry === "string");
        }
      } catch {
        // Ordinary text tool results are not JSON arrays.
      }
      return [raw];
    })
    .filter(Boolean)
    .join("\n");
}

function unescapeName(value) {
  return String(value || "").replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\"/g, "\"");
}

export function parseWindowsMcpElements(text) {
  const elements = [];
  const pattern = /\((-?\d+),(-?\d+)\)\s+(.+?)\s+"((?:\\.|[^"])*)"/g;
  for (const match of String(text || "").matchAll(pattern)) {
    elements.push({
      x: Number(match[1]),
      y: Number(match[2]),
      role: String(match[3] || "").trim(),
      name: unescapeName(match[4]),
      line: match[0]
    });
  }
  return elements;
}

export class WindowsMcpBridge {
  constructor(options = {}) {
    this.enabled = options.enabled ?? process.platform === "win32";
    this.command = String(options.command || process.env.NEXCORE_WINDOWS_MCP_BIN || "uvx");
    this.args = Array.isArray(options.args)
      ? options.args.map(String)
      : String(process.env.NEXCORE_WINDOWS_MCP_ARGS || "windows-mcp serve").split(/\s+/).filter(Boolean);
    this.timeoutMs = Number(options.timeoutMs) || 30000;
    this.client = null;
    this.connecting = null;
    this.tools = [];
    this.lastElements = [];
    this.closed = false;
  }

  async _ensure() {
    if (!this.enabled) throw Object.assign(new Error("Windows-MCP is disabled."), { code: "WMCP_DISABLED" });
    if (this.closed) throw Object.assign(new Error("Windows-MCP bridge is closed."), { code: "WMCP_CLOSED" });
    if (this.client) return this.client;
    this.connecting ||= (async () => {
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js")
      ]);
      const transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
        env: {
          ...process.env,
          ANONYMIZED_TELEMETRY: "false",
          WINDOWS_MCP_CONTROL: "false",
          WINDOWS_MCP_SCREENSHOT_SCALE: process.env.WINDOWS_MCP_SCREENSHOT_SCALE || "0.6",
          WINDOWS_MCP_MAX_TREE_ELEMENTS: process.env.WINDOWS_MCP_MAX_TREE_ELEMENTS || "2000",
          WINDOWS_MCP_MERGE_WORD_NODES: process.env.WINDOWS_MCP_MERGE_WORD_NODES || "1"
        }
      });
      const client = new Client({ name: "nexcore-ctrlcomputer", version: "0.4.0" });
      await client.connect(transport);
      const listed = await client.listTools();
      this.tools = listed.tools.map((tool) => tool.name);
      this.client = client;
      return client;
    })().catch((error) => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  async probe() {
    try {
      await this._ensure();
      return { ok: true, command: this.command, tools: this.tools };
    } catch (error) {
      return {
        ok: false,
        command: this.command,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async call(name, args = {}, timeoutMs = this.timeoutMs) {
    const client = await this._ensure();
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs }
    );
    if (result?.isError) {
      throw Object.assign(new Error(textContent(result) || `Windows-MCP ${name} failed.`), {
        code: "WMCP_TOOL_ERROR",
        tool: name
      });
    }
    return textContent(result);
  }

  async snapshot({ useVision = false, useUiTree = true } = {}) {
    const text = await this.call("Snapshot", {
      use_vision: useVision,
      use_ui_tree: useUiTree,
      use_annotation: false,
      use_dom: false
    }, Math.max(this.timeoutMs, 60000));
    const elements = parseWindowsMcpElements(text);
    this.lastElements = elements.map((element, index) => ({
      ...element,
      ref: `@wmcp:${index}`
    }));
    return { text, elements: this.lastElements };
  }

  element(ref) {
    const match = /^@wmcp:(\d+)$/.exec(String(ref || ""));
    if (!match) return null;
    return this.lastElements[Number(match[1])] || null;
  }

  async launch(app, executable = app) {
    const raw = String(app);
    const displayName = /calc|计算器/i.test(raw)
      ? "计算器"
      : /notepad|记事本/i.test(raw)
        ? "记事本"
        : "";
    if (displayName) {
      try {
        return await this.call("App", { mode: "launch", name: displayName });
      } catch {
        // Fall through to the explicit executable path.
      }
    }
    if (/[\\/]/.test(String(executable))) {
      return this.call("App", {
        mode: "launch_executable",
        executable: String(executable),
        args: []
      });
    }
    return this.call("App", { mode: "launch", name: String(app) });
  }

  async click(element, clicks = 1) {
    return this.call("Click", { loc: [element.x, element.y], clicks });
  }

  async type(element, text, { clear = false, pressEnter = false } = {}) {
    return this.call("Type", {
      loc: [element.x, element.y],
      text: String(text ?? ""),
      clear,
      press_enter: pressEnter
    });
  }

  async scroll(element, direction = "down", amount = 3) {
    return this.call("Scroll", {
      ...(element ? { loc: [element.x, element.y] } : {}),
      type: ["left", "right"].includes(direction) ? "horizontal" : "vertical",
      direction,
      wheel_times: Math.max(1, Number(amount) || 3)
    });
  }

  async press(keys) {
    return this.call("Shortcut", { shortcut: String(keys) });
  }

  async pressSequence(keys) {
    const results = [];
    for (const raw of keys) {
      const key = raw === "*" ? "shift+8" : raw === "=" ? "return" : String(raw);
      results.push(await this.press(key));
    }
    return results.join("\n");
  }

  async typeAtFocus(text) {
    await this.call("Clipboard", { mode: "set", text: String(text ?? "") });
    return this.call("Shortcut", { shortcut: "ctrl+v" });
  }

  async waitForText(text, timeoutMs = 5000) {
    return this.call("WaitFor", {
      condition: "text_exists",
      text: String(text),
      timeout: Math.max(0.25, timeoutMs / 1000),
      interval: 0.25
    }, Math.max(this.timeoutMs, timeoutMs + 5000));
  }

  async close() {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.lastElements = [];
    if (client) await client.close().catch(() => {});
  }
}
