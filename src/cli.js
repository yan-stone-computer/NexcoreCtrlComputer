#!/usr/bin/env node
import { createComputer, NexcoreError } from "./index.js";

const HELP = `NexcoreCtrlComputer

Usage:
  nexcore doctor
  nexcore observe '<json>'
  nexcore act '<json>'
  nexcore verify '<json>'
  nexcore run '<json-array>'
  nexcore mcp

Examples:
  nexcore observe '{"surface":"desktop","app":"Calculator"}'
  nexcore act '{"surface":"desktop","app":"Calculator","action":"click","target":{"role":"button","name":"7"}}'
  nexcore act '{"surface":"browser","url":"https://example.com","action":"click","target":{"role":"button","name":"More information..."}}'

Policy is supplied through the JS API or MCP client config. Coordinate control is off by default.`;

function parseJsonArgument(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new NexcoreError("INVALID_JSON", `Invalid JSON argument: ${error.message}`, { retry: "safe" });
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command, raw] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (command === "mcp") {
    await import("./mcp.js");
    return;
  }

  const computer = await createComputer({ session: process.env.NEXCORE_SESSION || "cli" });
  if (command === "doctor") {
    print(await computer.doctor());
    return;
  }
  if (command === "observe") {
    const result = await computer.observe(parseJsonArgument(raw, {}));
    process.stdout.write(`${result.text}\n`);
    return;
  }
  if (command === "act") {
    print(await computer.act(parseJsonArgument(raw, {})));
    return;
  }
  if (command === "verify") {
    print(await computer.verify(parseJsonArgument(raw, {})));
    return;
  }
  if (command === "run") {
    print(await computer.run(parseJsonArgument(raw, [])));
    return;
  }
  if (command === "close") {
    await computer.close();
    print({ ok: true });
    return;
  }
  throw new NexcoreError("UNKNOWN_COMMAND", `Unknown command: ${command}`, { retry: "safe" });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    error: error.name || "Error",
    code: error.code || "INTERNAL",
    message: error.message,
    retry: error.retry,
    details: error.details
  }, null, 2)}\n`);
  process.exitCode = 1;
});
