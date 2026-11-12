#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createComputer, NexcoreError } from "./index.js";

const HELP = `NexcoreCtrlComputer

Usage:
  nexcore doctor
  nexcore observe '<json>'
  nexcore act '<json>'
  nexcore verify '<json>'
  nexcore run '<json-array>'
  nexcore program save <file-or-json>
  nexcore program list
  nexcore program run <name> '<json-params>'
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
  if (command === "program") {
    const [subcommand, value, params] = process.argv.slice(3);
    if (subcommand === "save") {
      if (!value) throw new NexcoreError("PROGRAM_REQUIRED", "program save needs a file or JSON.", { retry: "safe" });
      const source = existsSync(value) ? readFileSync(value, "utf8") : value;
      print(await computer.saveProgram(parseJsonArgument(source, {})));
      return;
    }
    if (subcommand === "list") {
      print(await computer.listPrograms());
      return;
    }
    if (subcommand === "run") {
      if (!value) throw new NexcoreError("PROGRAM_REQUIRED", "program run needs a program name.", { retry: "safe" });
      print(await computer.runProgram(value, parseJsonArgument(params, {})));
      return;
    }
    throw new NexcoreError("UNKNOWN_PROGRAM_COMMAND", `Unknown program command: ${subcommand || ""}`, {
      retry: "safe"
    });
  }
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
