import { afterEach, describe, expect, test } from "vitest";
import { provePythonSandboxBoundary } from "./helpers/python-sandbox-boundary.js";
import { access } from "node:fs/promises";

import {
  PersistentPythonSandbox,
  type PersistentPythonSandboxOptions,
} from "../apps/server/src/training/cross-system-operations/python-sandbox";
import { PythonSandboxUnavailableError } from "../apps/server/src/training/cross-system-operations/python-sandbox-runtime";

const sandboxes: PersistentPythonSandbox[] = [];

function createSandbox(options: PersistentPythonSandboxOptions = {}): PersistentPythonSandbox {
  const sandbox = new PersistentPythonSandbox(options);
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

describe("PersistentPythonSandbox", () => {
  // Failure story: reflection defeats Python import filters. Even unrestricted
  // Python must not reach host services, credentials, or private grading files.
  test("contains the import bypass while preserving per-attempt Python state", async () => {
    await provePythonSandboxBoundary();
  });

  // Failure story: installing/running without bubblewrap must never silently
  // execute model code on the host, including subsequent calls after failure.
  test("fails closed when the isolation runtime is missing", async () => {
    const sandbox = createSandbox({ bwrapPath: "/missing-openpond-runtime/bwrap" });
    await expect(sandbox.run("_result = 1")).rejects.toBeInstanceOf(PythonSandboxUnavailableError);
    await expect(sandbox.run("_result = 2")).rejects.toBeInstanceOf(PythonSandboxUnavailableError);
  });

  test("enforces the parent-process resident-memory ceiling", async () => {
    const maxMemoryBytes = 256 * 1024 * 1024;
    const sandbox = createSandbox({
      maxMemoryBytes,
      memoryPollIntervalMs: 10,
      memoryUsage: async () => maxMemoryBytes + 1,
      timeoutMs: 1_000,
    });

    await expect(sandbox.run("while True:\n    pass")).rejects.toThrow(
      `exceeded the ${maxMemoryBytes}-byte memory limit`,
    );
  });

  // Failure story: a timed-out or cancelled worker cannot continue running or
  // accept later code; direct stdout writes must not bypass the output budget.
  test("terminates on timeout, cancellation, and unframed output overflow", async () => {
    let hostPid: number | undefined;
    const timed = createSandbox({ timeoutMs: 100, memoryPollIntervalMs: 10, memoryUsage: async pid => { hostPid = pid; return 0; } });
    try {
      await expect(timed.run(`
raw_import = __import__.__globals__["real_import"]
raw_import("ctypes").CDLL(None).prctl(1, 0, 0, 0, 0)
while True:
    pass
`)).rejects.toThrow("timed out");
      await expect(timed.run("_result = 1")).rejects.toThrow();
      expect(hostPid).toBeDefined();
      await expect.poll(async () => access(`/proc/${hostPid}`).then(() => true, () => false), { timeout: 1_000 }).toBe(false);
    } finally {
      if (hostPid) try { process.kill(hostPid, "SIGKILL"); } catch { /* Already exited. */ }
      await timed.close();
    }
    const cancelled = createSandbox();
    await cancelled.run("_result = 1");
    const controller = new AbortController();
    const running = cancelled.run("while True:\n    pass", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const output = createSandbox({ maxOutputBytes: 64 });
    await expect(output.run(`raw_import = __import__.__globals__["real_import"]\nraw_import("os").write(1, b"x" * 20000)`))
      .rejects.toThrow("output exceeded");
    // Self-termination is model-caused, not unavailable infrastructure that
    // could exempt a bad attempt from reward accounting.
    const crashed = createSandbox();
    await expect(crashed.run(`__import__.__globals__["real_import"]("os")._exit(1)`))
      .rejects.not.toBeInstanceOf(PythonSandboxUnavailableError);
  });
});
