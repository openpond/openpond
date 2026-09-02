import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Taskset } from "@openpond/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { ManagedRlHarnessExecutionInput } from "./managed-rl-harness-registry.js";
import { executePortableJsonlManagedRl } from "./portable-jsonl-managed-rl-adapter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("portable JSONL managed-RL runtime", () => {
  it("rejects a user-owned verifier whose contents do not match its declared hash", async () => {
    const fixture = await runtimeFixture({ moduleSha256: "0".repeat(64) });

    await expect(executePortableJsonlManagedRl(fixture.input)).rejects.toThrow(
      "portable_jsonl_module_hash_mismatch",
    );
    expect(fixture.policyRequests).toBe(0);
  });

  it("rejects verifier modules outside the declared Taskset directory", async () => {
    const fixture = await runtimeFixture({ externalModule: true });

    await expect(executePortableJsonlManagedRl(fixture.input)).rejects.toThrow(
      "portable_jsonl_module_outside_taskset",
    );
    expect(fixture.policyRequests).toBe(0);
  });
});

async function runtimeFixture(options: {
  externalModule?: boolean;
  moduleSha256?: string;
}): Promise<{ input: ManagedRlHarnessExecutionInput; policyRequests: number }> {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-portable-runtime-"));
  temporaryDirectories.push(storeDir);
  const sourceTasksetId = "user-owned-taskset";
  const tasksetRoot = path.join(storeDir, "training", "tasksets", sourceTasksetId);
  const graderDirectory = path.join(tasksetRoot, "graders");
  await mkdir(graderDirectory, { recursive: true });
  const moduleContents = "process.stdout.write('');\n";
  const modulePath = options.externalModule
    ? path.join(storeDir, "external-verifier.mjs")
    : path.join(graderDirectory, "verifier.mjs");
  await writeFile(modulePath, moduleContents, "utf8");
  const moduleSha256 = options.moduleSha256 ?? createHash("sha256").update(moduleContents).digest("hex");
  await writeFile(
    path.join(graderDirectory, "managed-rl-runtime.json"),
    JSON.stringify({
      protocolVersion: "openpond.managedRlJsonlRuntime.v1",
      module: path.relative(tasksetRoot, modulePath),
      moduleSha256,
      command: [process.execPath, "{module}"],
      cwd: tasksetRoot,
      maxTurns: 1,
    }),
    "utf8",
  );
  let policyRequests = 0;
  const taskset = {
    id: "derived-taskset",
    metadata: { importedFromTaskset: { id: sourceTasksetId } },
    environment: {
      kind: "stateful_harness",
      metadata: {},
      toolNames: [],
    },
    capabilities: { requiresState: true, requiresTools: true },
    graders: [{ id: "user-verifier-v1", rewardEligible: true }],
  } as unknown as Taskset;
  const input = {
    taskset,
    task: { id: "task-1", metadata: {} },
    storeDir,
    signal: new AbortController().signal,
    policyRequest: async () => {
      policyRequests += 1;
      return {};
    },
  } as unknown as ManagedRlHarnessExecutionInput;
  return {
    input,
    get policyRequests() {
      return policyRequests;
    },
  };
}
