import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Taskset } from "@openpond/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { TrainingHarnessExecutionInput } from "../apps/server/src/training/training-harness-registry.js";
import { executePortableJsonlTraining, validatePortableJsonlHarnessSource } from "../apps/server/src/training/portable-jsonl-training-adapter.js";
import { sourceRuntimeFixture } from "../packages/harness/test/source-runtime-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("released Harness JSONL execution", () => {
  it("executes captured instructions and Skill resources while an older release stays pinned", async () => {
    const fixture = await runtimeFixture({ moduleContents: `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  const result = request.operation === "init"
    ? { policy: "Return the requested label.", userPrompt: "Format the label.", tools: [] }
    : { toolResults: [], userMessage: null, terminal: true, reward: request.content === "BLUE" ? 1 : 0, components: { exact: request.content === "BLUE" ? 1 : 0 }, stateHashes: {} };
  process.stdout.write(JSON.stringify(result) + "\\n");
}
`, maxTurns: 4 });
    const original = sourceRuntimeFixture();
    const changed = sourceRuntimeFixture({ format: "lowercase" });
    await validatePortableJsonlHarnessSource({ taskset: fixture.input.taskset, storeDir: fixture.input.storeDir, harnessSource: original });
    await expect(validatePortableJsonlHarnessSource({
      taskset: { ...fixture.input.taskset, environment: { ...fixture.input.taskset.environment, toolNames: ["missing_tool"] } },
      storeDir: fixture.input.storeDir, harnessSource: original,
    })).rejects.toThrow("portable_jsonl_tool_contract_mismatch");
    expect(fixture.policyRequests).toBe(0);
    const run = async (harnessSource: typeof original) => {
      const requests: Array<Record<string, unknown>> = [];
      const result = await executePortableJsonlTraining({ ...fixture.input, harnessSource,
        executorId: "source-test", harnessRoot: "unused-current-workspace",
        claim: { schemaVersion: "openpond.managedRlLocalRolloutClaim.v1", executionKind: "evaluation", executionId: "eval-source",
          jobId: "job-source", groupId: null, rolloutId: null, deliveryId: "delivery-source", policyVersion: 0,
          task: { id: "task-1", expectedText: null }, taskset: { id: "derived-taskset", revision: 1, contentHash: "a".repeat(64) },
          harnessRelease: { id: harnessSource.harnessRelease.id, contentHash: harnessSource.harnessRelease.contentHash },
          reward: { kind: "local_harness_receipt_v1", environmentId: "source-test" }, environmentSha256: "b".repeat(64), request: { seed: 1 }, policy: { path: "unused", token: "unused" } },
        policyRequest: async request => {
          requests.push(structuredClone(request));
          const messages = request.messages as Array<{ role: string; content: string }>;
          const resource = [...messages].reverse().find(message => message.role === "tool");
          // This deterministic policy fixture makes source consumption observable
          // without calling a model or starting a training worker.
          const label = resource ? String(JSON.parse(resource.content).content) : "";
          const content = label ? (messages[0]!.content.includes("as uppercase.") ? label.toUpperCase() : label.toLowerCase()) : "";
          return { response: { choices: [{ message: { content, tool_calls: resource ? [] : [{ id: "read-source", type: "function",
            function: { name: "harness_read_file", arguments: JSON.stringify({ path: "skills/label/reference.txt" }) } }] } }] },
            trainingSample: { modelRequestId: `request-${requests.length}` } };
        },
      });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests)).not.toContain("PRIVATE_GRADER_SOURCE_NOT_POLICY_CONTEXT");
      expect(result.trace).toMatchObject({ harnessSourceRuntime: { sourcePackageHash: harnessSource.contentHash }, toolSequence: ["harness_read_file"] });
      return result.trace as { reward: number; traceSha256: string };
    };
    const before = await run(original);
    expect(before.reward).toBe(1);
    expect((await run(changed)).reward).toBe(0);
    expect(await run(original)).toEqual(before);
  });
});

async function runtimeFixture(options: {
  moduleContents: string;
  maxTurns: number;
}): Promise<{ input: TrainingHarnessExecutionInput; policyRequests: number }> {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-portable-runtime-"));
  temporaryDirectories.push(storeDir);
  const sourceTasksetId = "user-owned-taskset";
  const tasksetRoot = path.join(storeDir, "training", "tasksets", sourceTasksetId);
  const graderDirectory = path.join(tasksetRoot, "graders");
  await mkdir(graderDirectory, { recursive: true });
  const moduleContents = options.moduleContents;
  const modulePath = path.join(graderDirectory, "verifier.mjs");
  await writeFile(modulePath, moduleContents, "utf8");
  const moduleSha256 = createHash("sha256").update(moduleContents).digest("hex");
  await writeFile(
    path.join(graderDirectory, "managed-rl-runtime.json"),
    JSON.stringify({
      protocolVersion: "openpond.managedRlJsonlRuntime.v1",
      module: path.relative(tasksetRoot, modulePath),
      moduleSha256,
      command: [process.execPath, "{module}"],
      cwd: tasksetRoot,
      maxTurns: options.maxTurns,
    }),
    "utf8",
  );
  let policyRequests = 0;
  const taskset = {
    id: "derived-taskset",
    metadata: { importedFromTaskset: { id: sourceTasksetId } },
    tasks: [{ id: "task-1", split: "train", metadata: {} }],
    environment: {
      kind: "stateful_harness",
      defaultTimeoutMs: 5_000,
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
  } as unknown as TrainingHarnessExecutionInput;
  return {
    input,
    get policyRequests() {
      return policyRequests;
    },
  };
}
