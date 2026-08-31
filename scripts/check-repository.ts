import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBinary = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const checks = [
  "scripts/check-source-structure.ts",
  "scripts/check-production-entrypoints.ts",
  "scripts/check-workspace-dependencies.ts",
] as const;

const results = await Promise.all(checks.map(runCheck));
const failures = results.filter((result) => result.code !== 0);
if (failures.length > 0) {
  throw new Error(
    failures
      .map((failure) => `${failure.script} failed with ${failure.signal ?? `exit code ${failure.code}`}`)
      .join("\n"),
  );
}
console.log(`Repository checks passed in parallel (${checks.length} checks).`);

async function runCheck(script: string): Promise<{
  script: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  const child = spawn(tsxBinary, [script], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ script, code, signal }));
  });
}
