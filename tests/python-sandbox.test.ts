import { afterEach, describe, expect, test } from "vitest";

import {
  PersistentPythonSandbox,
  type PersistentPythonSandboxOptions,
} from "../apps/server/src/training/cross-system-operations/python-sandbox";

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
  test("starts when the host rejects a finite native address-space limit", async () => {
    const sandbox = createSandbox();

    await expect(sandbox.run("counter = 4\n_result = counter")).resolves.toMatchObject({
      ok: true,
      result: 4,
    });
  });

  test("enforces the parent-process resident-memory ceiling", async () => {
    const sandbox = createSandbox({
      maxMemoryBytes: 1_024,
      memoryPollIntervalMs: 10,
      memoryUsage: async () => 1_025,
      timeoutMs: 1_000,
    });

    await expect(sandbox.run("while True:\n    pass")).rejects.toThrow(
      "exceeded the 1024-byte memory limit",
    );
  });
});
