import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createComputer } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const program = JSON.parse(readFileSync(join(root, "examples", "programs", "browser-fill.json"), "utf8"));
const programDir = mkdtempSync(join(tmpdir(), "nexcore-program-smoke-"));
const computer = await createComputer({
  session: `program-smoke-${Date.now()}`,
  programDir,
  policy: {
    allowHeaded: false,
    allowCoordinates: false
  }
});

try {
  await computer.saveProgram(program);
  const result = await computer.runProgram("browser.fill", { value: "--hello" });
  assert.equal(result.ok, true);
  assert.equal(result.program, "browser.fill");
  assert.equal(result.steps.at(-1).verification.ok, true);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await computer.close();
  rmSync(programDir, { recursive: true, force: true });
}
