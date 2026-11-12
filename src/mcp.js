#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createComputer } from "./index.js";

const VERSION = "0.1.0";

const tool = {
  name: "computer",
  title: "Control this computer",
  description:
    "Observe and control desktop or browser UI through accessibility refs. Prefer observe -> act -> verify; use screenshots only when structure is insufficient. One tool handles status, observe, act, batched runs, and close.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["status", "observe", "act", "run", "close"], default: "observe" },
      surface: { type: "string", enum: ["auto", "desktop", "browser"], default: "auto" },
      app: { type: "string", description: "Desktop application name from list-apps." },
      url: { type: "string", description: "Browser URL. Open it before observing unless open is false." },
      open: { type: "boolean", description: "Open url before browser observation. Default true." },
      query: { type: "string", description: "Literal filter over role, name, value, or description." },
      delta: { type: "boolean", description: "Return unchanged or changed lines after the first observation. Default true." },
      maxNodes: { type: "integer", minimum: 1, maximum: 1000 },
      depth: { type: "integer", minimum: 1, maximum: 50 },
      selector: { type: "string", description: "Optional browser CSS scope." },
      action: {
        type: "string",
        enum: [
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
          "scroll",
          "coordinate_click",
          "screenshot"
        ]
      },
      target: {
        anyOf: [
          { type: "string", description: "An accessibility ref from the latest observation." },
          {
            type: "object",
            properties: {
              role: { type: "string" },
              name: { type: "string" },
              first: { type: "boolean" },
              x: { type: "number" },
              y: { type: "number" }
            },
            additionalProperties: false
          }
        ]
      },
      text: { type: "string", description: "Text for fill or type." },
      value: { type: "string", description: "Value for select or expected value in verify." },
      keys: { type: "string", description: "Keyboard chord, such as Control+s." },
      path: { type: "string", description: "Screenshot output path. Defaults to the OS temp directory." },
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", minimum: 1 },
      headed: { type: "boolean", description: "Use physical input when no semantic path exists. Disabled by default." },
      expect: {
        type: "object",
        description: "Post-action verification.",
        properties: {
          target: {},
          ref: { type: "string" },
          property: { type: "string", default: "value" },
          value: {},
          timeoutMs: { type: "integer", minimum: 0 }
        }
      },
      steps: {
        type: "array",
        description: "For mode=run: items containing observe, act, or verify.",
        items: { type: "object" }
      },
      continueOnError: { type: "boolean" }
    },
    additionalProperties: false
  }
};

const computer = await createComputer({
  session: process.env.NEXCORE_SESSION || "mcp",
  policy: {
    allowHeaded: process.env.NEXCORE_ALLOW_HEADED === "1",
    allowCoordinates: process.env.NEXCORE_ALLOW_COORDINATES === "1",
    allowedApps: process.env.NEXCORE_ALLOWED_APPS?.split(",").filter(Boolean),
    allowedDomains: process.env.NEXCORE_ALLOWED_DOMAINS?.split(",").filter(Boolean)
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

async function call(args) {
  const mode = args.mode || "observe";
  if (mode === "status") return computer.doctor();
  if (mode === "observe") {
    const result = await computer.observe(args);
    return result.text;
  }
  if (mode === "act") return computer.act(args);
  if (mode === "run") return computer.run(args.steps || [], { continueOnError: args.continueOnError });
  if (mode === "close") {
    await computer.close();
    return { ok: true };
  }
  throw new Error(`Unknown mode: ${mode}`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    response(id, {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "nexcorectrlcomputer", version: VERSION },
      instructions:
        "Use computer(mode=observe) first. Act on fresh refs or role/name targets. Add expect to actions that must be verified. Use screenshots only when the accessibility tree cannot represent the target."
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    response(id, {});
    return;
  }
  if (method === "tools/list") {
    response(id, { tools: [tool] });
    return;
  }
  if (method === "tools/call") {
    if (params.name !== "computer") {
      failure(id, -32602, `Unknown tool: ${params.name}`);
      return;
    }
    try {
      const result = await call(params.arguments || {});
      const text = typeof result === "string" ? result : JSON.stringify(result);
      response(id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      response(id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            code: error.code || "INTERNAL",
            message: error.message,
            retry: error.retry,
            details: error.details
          })
        }],
        isError: true
      });
    }
    return;
  }
  if (method === "shutdown") {
    response(id, null);
    await computer.close();
    process.exit(0);
  }
  if (id !== undefined) failure(id, -32601, `Method not found: ${method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
  }
});
