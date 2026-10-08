import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { provePythonSandboxBoundary } from "../../tests/helpers/python-sandbox-boundary.js";
import { PersistentPythonSandbox } from "../../apps/server/src/training/cross-system-operations/python-sandbox.js";
import { PythonSandboxUnavailableError } from "../../apps/server/src/training/cross-system-operations/python-sandbox-runtime.js";

const checks = await provePythonSandboxBoundary();
const missing = new PersistentPythonSandbox({ bwrapPath: "/missing-openpond-runtime/bwrap" });
try {
  await assert.rejects(missing.run("_result = 1"), PythonSandboxUnavailableError);
  checks.unavailable_fails_closed = true;
} finally {
  await missing.close();
}
const sourceSha256 = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
console.log(JSON.stringify({ status: "PASS", sourceSha256, checks }));
