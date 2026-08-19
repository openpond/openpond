import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SessionSchema,
  type Session,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import { loadLocalHarnessRuntimeFromRelease } from
  "../../../apps/server/src/harness/local-harness-skill-runtime.js";
import { createLocalHarnessWorkspace } from
  "../../../apps/server/src/harness/local-harness-workspace-service.js";
import { SqliteStore } from "../../../apps/server/src/store/store.js";
import {
  createWebFetchModelToolDefinition,
  createWebSearchModelToolDefinition,
} from "../../../apps/server/src/openpond/model-tool-registry.js";
import { createBenchmarkTasksetService } from
  "../../../apps/server/src/training/benchmark-tasksets.js";
import { createTaskEvaluationService } from
  "../../../apps/server/src/training/evaluation-service.js";

const storeDir = process.env.OPENPOND_APP_HOME?.trim();
if (!storeDir) throw new Error("OPENPOND_APP_HOME is required for conformance.");
const outputPath = path.resolve(
  process.env.OPENPOND_REFINER_CONFORMANCE_OUTPUT?.trim()
    || path.join(storeDir, "harness-refiner-conformance.json"),
);
const timestamp = "2026-08-18T18:00:00.000Z";
const store = new SqliteStore(storeDir);

try {
  const benchmarkTasksets = createBenchmarkTasksetService({
    store,
    storeDir,
    now: () => timestamp,
  });
  const taskset = await benchmarkTasksets.ensureHarnessRefiner({
    profileId: "harness-refiner-conformance",
  });
  if (
    taskset.graders.length !== 1
    || taskset.graders[0]?.kind !== "custom_verifier"
    || taskset.benchmark?.primaryMetric !== "success_rate"
  ) {
    throw new Error("Conformance requires one deterministic primary-reward verifier.");
  }
  const release = await benchmarkTasksets.releaseForTaskset(taskset);
  if (!release) throw new Error("The portable Taskset Release is unavailable.");
  const createdHarness = await createLocalHarnessWorkspace({
    store,
    storeDir,
    id: "harness-refiner-conformance",
    ownerId: "harness-refiner-conformance",
    name: "Harness Refiner conformance",
    now: () => timestamp,
  });
  const runtime = await loadLocalHarnessRuntimeFromRelease({
    workspace: createdHarness.workspace,
    release: createdHarness.release,
  });
  let session: Session | null = null;
  const evaluation = createTaskEvaluationService({
    store,
    storeDir,
    modelText: async () => "",
    modelStream: async function* () {
      yield {
        text: "Subject: Acme pilot launch update\n\nThe August 20 launch is moving to August 27 because final accessibility testing is not complete. Testing is expected to finish August 22, and existing pilot access remains available. Please send questions to pilot-support@example.com. Thank you for your patience while we complete this work.",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        costUsd: 0,
      };
    },
    workRuntime: {
      createSession: async (payload) => {
        const record = payload as Record<string, unknown>;
        session = SessionSchema.parse({
          ...record,
          id: "harness-refiner-conformance-session",
          title: String(record.title ?? "Harness Refiner conformance"),
          appId: null,
          appName: null,
          cwd: null,
          codexThreadId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          status: "idle",
          pinned: false,
          archived: false,
          order: 0,
        });
        await store.insertSessionAtFront(session);
        return session;
      },
      getSession: async () => {
        if (!session) throw new Error("Conformance Work session is unavailable.");
        return session;
      },
      runtimeEventsForSession: (sessionId) => store.runtimeEventsForSession(sessionId),
      executeWorkspaceTool: async (_sessionId, payload) => {
        const action = String((payload as { action?: unknown }).action ?? "unknown");
        return {
          ok: true,
          action,
          output: "Conformance local Work environment is ready.",
          data: action === "sandbox_status" || action === "sandbox_create"
            ? { sandbox: { id: "conformance-local", state: "running" } }
            : action === "sandbox_receipts"
              ? { billableUsd: 0, simulatedUsd: 0, settlementMode: "desktop_local" }
              : {},
        } as WorkspaceToolResult;
      },
      settleCostEvidence: async () => ({
        ok: true,
        action: "sandbox_receipts",
        output: "Conformance local Work has no billable sandbox cost.",
        data: { billableUsd: 0, simulatedUsd: 0, settlementMode: "desktop_local" },
      }),
    },
    additionalWorkToolDefinitions: () => [
      createWebSearchModelToolDefinition({
        executeWebSearch: async () => {
          throw new Error("The scripted conformance attempt never executes web search.");
        },
      }),
      createWebFetchModelToolDefinition(),
    ],
    resolveTasksetRelease: () => Promise.resolve(release),
  });
  const result = await evaluation.execute({
    tasksetId: taskset.id,
    taskId: "adaptation-launch-delay-email",
    model: {
      providerId: "openpond",
      modelId: "accounts/fireworks/models/deepseek-v4-flash",
    },
    reasoningEffort: "low",
    seed: 17,
    attempt: 0,
    admittedAt: timestamp,
    resultId: "harness-refiner-conformance-attempt",
    releasedHarness: {
      agentSnapshot: runtime.release.agentSnapshot,
      harnessRelease: runtime.release.harnessRelease,
      instructionContext: runtime.instructionContext,
    },
  });
  if (
    !result.grade.passed
    || result.grade.score !== 1
    || !result.grade.rewardEligible
    || result.portable.rewardReceipt.status !== "scored"
    || result.portable.rewardReceipt.reward !== 1
    || !result.portable.rewardReceipt.passed
  ) {
    throw new Error("The deterministic conformance attempt did not earn verified reward.");
  }
  const requiredKinds = new Set([
    "artifact_manifest",
    "canonical_rollout",
    "reward_receipt",
  ]);
  for (const kind of requiredKinds) {
    if (!result.artifacts.some((artifact) => artifact.kind === "grader_evidence"
      && artifact.path.includes(kind.replaceAll("_", "-")))) {
      throw new Error(`The conformance attempt is missing ${kind}.`);
    }
  }
  const core = {
    schemaVersion: "openpond.harnessRefinerConformance.v1",
    id: "harness-refiner-conformance-20260818-v1",
    status: "passed",
    taskset: { id: release.id, contentHash: release.contentHash },
    model: {
      providerId: "openpond",
      modelId: "accounts/fireworks/models/deepseek-v4-flash",
    },
    scriptedForeground: true,
    taskId: "adaptation-launch-delay-email",
    attempt: {
      id: result.attempt.id,
      contentHash: result.portable.receipt.contentHash,
    },
    rewardReceipt: {
      id: result.portable.rewardReceipt.id,
      contentHash: result.portable.rewardReceipt.contentHash,
      reward: result.portable.rewardReceipt.reward,
      passed: result.portable.rewardReceipt.passed,
    },
    artifactManifest: {
      id: result.portable.artifactManifest.id,
      contentHash: result.portable.artifactManifest.contentHash,
    },
    evaluationResult: {
      id: result.portable.evaluationResult.id,
      contentHash: result.portable.evaluationResult.contentHash,
    },
    graderCount: taskset.graders.length,
    modelJudgeCalls: 0,
    completedAt: timestamp,
  } as const;
  const receipt = { ...core, contentHash: contentHash(core) };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(
    `CONFORMANCE_PASS ${receipt.taskset.id} ${receipt.contentHash} ${outputPath}\n`,
  );
} finally {
  await store.close();
}
