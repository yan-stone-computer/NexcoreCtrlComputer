import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("MCP exposes one compact computer tool", async () => {
  const child = spawn(process.execPath, [join(root, "src", "mcp.js")], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ];
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);

  const output = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("MCP server timed out")), 5000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.trim().split("\n").length >= 2) {
        clearTimeout(timer);
        resolve(buffer);
      }
    });
    child.on("error", reject);
  });
  child.kill();

  const rows = output.trim().split("\n").map((line) => JSON.parse(line));
  const list = rows.find((row) => row.id === 2);
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, "computer");
  const modes = list.result.tools[0].inputSchema.properties.mode.enum;
  assert.ok(modes.includes("program_save"));
  assert.ok(modes.includes("program_list"));
  assert.ok(modes.includes("program_run"));
});
