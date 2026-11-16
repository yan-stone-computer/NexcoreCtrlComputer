#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync, statSync } from "node:fs";
import { createComputer } from "./index.js";

const VERSION = "0.5.0";

const tool = {
  name: "computer",
  title: "Control this computer",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  },
  description:
    "Observe and control desktop or browser UI through accessibility refs. Use software to list installed Start Menu applications, adapters to inspect available control engines and CLI adapters, and apps only for running applications. Desktop inventory views also include windows, displays, notifications, surfaces, and short-lived visual frames. Prefer observe -> act -> verify. Use view=visual only when structure is insufficient; it returns a compact image, DPI-safe grid, and frameId for guarded pointer actions. One tool handles status, observe, act, batched runs, and close.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["status", "observe", "act", "run", "program_save", "program_list", "program_run", "close"],
        default: "observe"
      },
      surface: { type: "string", enum: ["auto", "desktop", "browser"], default: "auto" },
      view: {
        type: "string",
        enum: ["semantic", "windows", "apps", "displays", "notifications", "surfaces", "software", "adapters", "visual"],
        description: "Observation view. Use visual for a full-screen frame plus grid."
      },
      app: { type: "string", description: "Desktop application name from list-apps." },
      url: { type: "string", description: "Browser URL. Open it before observing unless open is false." },
      open: { type: "boolean", description: "Open url before browser observation. Default true." },
      query: { type: "string", description: "Literal filter over role, name, value, or description." },
      delta: { type: "boolean", description: "Return unchanged or changed lines after the first observation. Default true." },
      grid: {
        type: "object",
        description: "For view=visual: coarse coordinate grid. Defaults to 8 columns by 6 rows.",
        properties: {
          columns: { type: "integer", minimum: 2, maximum: 16 },
          rows: { type: "integer", minimum: 2, maximum: 16 }
        },
        additionalProperties: false
      },
      gridColumns: { type: "integer", minimum: 2, maximum: 16 },
      gridRows: { type: "integer", minimum: 2, maximum: 16 },
      inlineImage: { type: "boolean", description: "For view=visual: return the screenshot as MCP image content. Default true." },
      includeCandidates: { type: "boolean", description: "For view=visual: merge accessible controls into annotated visual candidates. Default true." },
      maxCandidates: { type: "integer", minimum: 1, maximum: 80, description: "Maximum accessible visual candidates. Default 32." },
      frameId: { type: "string", description: "For a visual zoom: parent frame id from a previous visual observation." },
      candidateId: { type: "string", description: "For a visual zoom: candidate id such as v3." },
      region: {
        type: "object",
        description: "For a visual zoom: candidate/cell/normalized region.",
        properties: {
          candidateId: { type: "string" },
          cell: { type: "string" },
          normalized: {
            type: "object",
            properties: {
              x: { type: "number", minimum: 0, maximum: 1 },
              y: { type: "number", minimum: 0, maximum: 1 },
              width: { type: "number", minimum: 0, maximum: 1 },
              height: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      previewMaxWidth: { type: "integer", minimum: 320, maximum: 3840, description: "Visual preview width. Default 1600." },
      previewQuality: { type: "integer", minimum: 40, maximum: 95, description: "Visual preview JPEG quality. Default 82." },
      frameTtlMs: { type: "integer", minimum: 1000, maximum: 120000 },
      frameMaxAgeMs: { type: "integer", minimum: 1000, maximum: 120000 },
      pointerDurationMs: { type: "integer", minimum: 0, maximum: 5000, description: "Optional visible pointer travel time for visual clicks." },
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
              frameId: { type: "string", description: "Visual frame id from observe({view:'visual'})." },
              zoomId: { type: "string", description: "Visual zoom id from observe({view:'visual',frameId,region})." },
              candidateId: { type: "string", description: "Candidate id such as v3." },
              cell: { type: "string", description: "Visual grid cell such as C4." },
              normalized: {
                type: "object",
                properties: {
                  x: { type: "number", minimum: 0, maximum: 1 },
                  y: { type: "number", minimum: 0, maximum: 1 }
                },
                required: ["x", "y"],
                additionalProperties: false
              },
              at: {
                type: "object",
                properties: {
                  x: { type: "number", minimum: 0, maximum: 1 },
                  y: { type: "number", minimum: 0, maximum: 1 }
                },
                required: ["x", "y"],
                additionalProperties: false
              },
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
      program: { type: "object", description: "For mode=program_save: a nexcore.program/v1 definition." },
      programName: { type: "string", description: "For mode=program_run: saved semantic program name." },
      params: { type: "object", description: "For mode=program_run: typed program parameters." },
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
    return result;
  }
  if (mode === "act") return computer.act(args);
  if (mode === "run") return computer.run(args.steps || [], { continueOnError: args.continueOnError });
  if (mode === "program_save") return computer.saveProgram(args.program);
  if (mode === "program_list") return computer.listPrograms();
  if (mode === "program_run") {
    return computer.runProgram(args.programName, args.params || {});
  }
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
        "Prefer saved semantic programs for repeated workflows: use program_run with parameters. For new work, observe, act on role/name targets, and add expect where state matters. Screenshots are a manual last resort."
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
      const text = typeof result === "string" ? result : String(result.text || JSON.stringify(result));
      const content = [{ type: "text", text }];
      if (result && typeof result === "object" && result.inlineImage !== false && result.imagePath) {
        try {
          const size = statSync(result.imagePath).size;
          if (size <= 8 * 1024 * 1024) {
            content.push({
              type: "image",
              data: readFileSync(result.imagePath).toString("base64"),
              mimeType: result.mimeType || "image/png"
            });
          } else {
            content.push({ type: "text", text: `Image omitted: ${size} bytes exceeds the 8 MiB MCP inline limit.` });
          }
        } catch (error) {
          content.push({ type: "text", text: `Image unavailable: ${error.message}` });
        }
      }
      response(id, { content, isError: false });
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
let queue = Promise.resolve();
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
    return;
  }
  queue = queue
    .then(() => handle(message))
    .catch((error) => send({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: error.message } }));
});
lines.on("close", () => {
  queue.finally(() => computer.close()).finally(() => process.exit(0));
});
