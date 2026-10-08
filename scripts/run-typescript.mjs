// Keep local compiler runs responsive. Sandbox uses the same runner and lock.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, getPriority, setPriority, tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const [compiler, ...args] = process.argv.slice(2);
if (compiler !== "tsc" && compiler !== "tsgo") {
  console.error("Usage: node scripts/run-typescript.mjs <tsc|tsgo> [compiler arguments]");
  process.exit(1);
}

const packagePath = require.resolve(`${compiler === "tsc" ? "typescript" : "@typescript/native-preview"}/package.json`);
const entry = path.join(path.dirname(packagePath), require(packagePath).bin[compiler]);
const ci = process.env.CI && !["0", "false"].includes(process.env.CI.toLowerCase());
const gentle = !ci && process.env.TYPECHECK_UNRESTRICTED !== "1";
const env = { ...process.env };
let command = process.execPath;
let commandArgs = [entry, ...args];

if (gentle) {
  // Children inherit niceness on Unix; also set the child's priority on Windows.
  setPriority(Math.max(getPriority(), constants.priority.PRIORITY_BELOW_NORMAL));
  if (compiler === "tsgo") {
    env.GOMAXPROCS ??= "2";
    // This is a Go GC target, not a hard RSS cap or a reason to skip checks.
    env.GOMEMLIMIT ??= "2GiB";
  }
  if (process.platform === "linux") {
    // One compiler per user across both repositories/worktrees. Kernel locks
    // release on exit/crash; never unlink the file (that would split the queue).
    const directory = path.join(tmpdir(), `openpond-typescript-${process.getuid()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    command = "flock";
    // Keep ownership in flock: tsgo's Node shim execs the native binary and
    // may close inherited descriptors. The supervisor must retain the lock.
    commandArgs = ["--exclusive", "--close", path.join(directory, "compiler.lock"), process.execPath, ...commandArgs];
    console.error("[typescript] Low priority; waiting for the shared local compiler slot if busy.");
  }
}

// A separate group lets cancellation stop the compiler and any shim children,
// including while flock is waiting. Keep the parent alive until they exit.
const grouped = process.platform !== "win32";
const child = spawn(command, commandArgs, { env, stdio: "inherit", detached: grouped });
if (gentle && process.platform === "win32" && child.pid) {
  setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
}
child.on("error", (error) => {
  console.error(`[typescript] ${error.message}${command === "flock" ? " (Linux local checks require util-linux/flock.)" : ""}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (128 + (constants.signals[signal] ?? 1));
});
