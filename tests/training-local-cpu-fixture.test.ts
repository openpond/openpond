import { describe, expect, test } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TrainingApprovalSchema, TrainingJobSchema } from "../packages/contracts/src";
import { buildTaskset } from "../packages/taskset-sdk/src";
import { buildTrainingBundle } from "../packages/training-sdk/src";
import { LocalCpuTrainingDestination } from "../apps/server/src/training/local-cpu-destination";
import { createEvidenceSnapshot, createTasksetRef } from "../apps/server/src/training/create-improve-taskset-lineage";
import { createModelTrainingCreateImproveRun } from "../apps/server/src/training/model-create-improve";
import { syncModelTrainingCreateImproveRuns } from "../apps/server/src/training/model-create-improve-reconciliation";
import { planFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe.sequential("local CPU training fixture", () => {
  test("runs LoRA SFT, imports verified artifacts, reloads, evaluates, and records immutable lineage", async () => withTrainingStore(async ({ store, directory }) => {
    const setup = await setupFixture(store, directory);
    const destination = setup.destination;
    const job = await destination.launch(setup.plan, setup.approval);
    const evidence = createEvidenceSnapshot({
      objective: setup.taskset.objective,
      sources: setup.taskset.sourceRefs,
      timestamp: setup.taskset.createdAt,
    });
    const createImproveRun = createModelTrainingCreateImproveRun({
      profileId: setup.taskset.profileId,
      tasksetId: setup.taskset.id,
      displayName: setup.taskset.name,
      trainingPlanId: setup.plan.id,
      trainingJobId: job.id,
      tasksetRef: createTasksetRef({
        taskset: setup.taskset,
        evidenceSnapshotIds: [evidence.id],
        approvedAt: setup.taskset.createdAt,
      }),
      evidenceSnapshots: [evidence],
    });
    await store.upsertCreateImproveRun(createImproveRun);
    const completed = await waitForTerminal(destination, job.id);
    expect(completed).toMatchObject({ status: "succeeded", nonProduction: true, metadata: { reloadVerified: true, frozenEvaluationExecuted: true } });
    const [events, artifacts, models] = await Promise.all([store.listTrainingJobEvents(job.id), store.listTrainingArtifacts(job.id), store.listModelArtifactLineage(setup.taskset.id)]);
    expect(events.map((event) => event.type)).toEqual(["start", "progress", "metric", "progress", "metric", "metric", "complete"]);
    expect(events.filter((event) => event.payload.metricKind === "sft_step")).toHaveLength(2);
    expect(artifacts.some((artifact) => artifact.kind === "adapter" && artifact.path.endsWith("adapter_model.safetensors"))).toBe(true);
    expect(artifacts.some((artifact) => artifact.kind === "evaluation")).toBe(true);
    expect(artifacts.some((artifact) => artifact.kind === "log")).toBe(true);
    expect(await store.listTaskAttemptArtifacts({ tasksetId: setup.taskset.id })).toHaveLength(2);
    expect(models[0]).toMatchObject({ promotable: false, status: "imported", frozenEvaluationArtifactId: expect.any(String) });
    await syncModelTrainingCreateImproveRuns({
      store,
      profileId: setup.taskset.profileId,
      execution: { jobs: [completed], models },
    });
    const synchronizedRun = await store.getCreateImproveRun(createImproveRun.id);
    expect(synchronizedRun).toMatchObject({
      state: "blocked",
      target: { artifactId: models[0]?.artifactId },
      blockedReason: expect.stringContaining("trained model failed"),
    });
    expect(synchronizedRun?.evaluationReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "active", evaluatorKind: "taskset", tasksetHash: setup.taskset.contentHash }),
      expect.objectContaining({ subject: "candidate", evaluatorKind: "taskset", status: "failed", tasksetHash: setup.taskset.contentHash }),
    ]));
    expect(new Set(synchronizedRun?.evaluationReceipts.map((receipt) => receipt.metadata.executionContractHash)).size).toBe(1);
    await syncModelTrainingCreateImproveRuns({
      store,
      profileId: setup.taskset.profileId,
      execution: { jobs: [completed], models },
    });
    expect((await store.getCreateImproveRun(createImproveRun.id))?.revision).toBe(synchronizedRun?.revision);
    expect(job.workerPid && processIsAlive(job.workerPid)).toBe(false);
    const importedJob = await destination.importExternal({ planId: setup.plan.id, bundleId: setup.bundle.id, artifactDirectory: String(completed.metadata.outputDirectory) });
    const imported = await waitForTerminal(destination, importedJob.id);
    expect(imported).toMatchObject({ status: "succeeded", metadata: { manualImport: true, reloadVerified: true, frozenEvaluationExecuted: true } });
    expect(await store.listModelArtifactLineage(setup.taskset.id)).toHaveLength(2);
    await destination.close();
  }), 30_000);

  test("cancels workers and reconciles interrupted desktop jobs without orphan claims", async () => withTrainingStore(async ({ store, directory }) => {
    const setup = await setupFixture(store, directory);
    const job = await setup.destination.launch(setup.plan, setup.approval);
    await setup.destination.cancel(job.id);
    expect((await waitForTerminal(setup.destination, job.id)).status).toBe("cancelled");
    const interrupted = TrainingJobSchema.parse({ ...job, id: "job_interrupted", status: "running", workerPid: null, completedAt: null, error: null, updatedAt: job.updatedAt });
    await store.saveTrainingJob(interrupted);
    await setup.destination.reconcile();
    expect(await store.getTrainingJob(interrupted.id)).toMatchObject({ status: "failed", error: expect.stringContaining("restarted") });
    await setup.destination.close();
  }), 30_000);

  test("turns injected worker errors into durable failed jobs", async () => withTrainingStore(async ({ store, directory }) => {
    const setup = await setupFixture(store, directory);
    const previous = process.env.OPENPOND_TRAINING_INJECT_FAILURE;
    process.env.OPENPOND_TRAINING_INJECT_FAILURE = "1";
    try {
      const job = await setup.destination.launch(setup.plan, setup.approval);
      expect((await waitForTerminal(setup.destination, job.id)).status).toBe("failed");
      expect((await store.listTrainingJobEvents(job.id)).at(-1)?.type).toBe("failure");
    } finally {
      if (previous === undefined) delete process.env.OPENPOND_TRAINING_INJECT_FAILURE;
      else process.env.OPENPOND_TRAINING_INJECT_FAILURE = previous;
      await setup.destination.close();
    }
  }), 30_000);

  test("executes the Taskset's sandboxed verifier for frozen evaluation", async () => withTrainingStore(async ({ store, directory }) => {
    const setup = await setupFixture(store, directory, { customVerifier: true });
    try {
      const job = await setup.destination.launch(setup.plan, setup.approval);
      expect((await waitForTerminal(setup.destination, job.id)).status).toBe("succeeded");
      const grades = await store.listGradeResultsForTaskset(setup.taskset.id);
      expect(grades).toHaveLength(2);
      expect(grades.every((grade: any) => grade.feedback.includes("Sandbox verifier executed."))).toBe(true);
      expect(grades.some((grade: any) => grade.feedback.some((feedback: string) => feedback.includes("unavailable")))).toBe(false);
    } finally { await setup.destination.close(); }
  }), 30_000);
});

async function setupFixture(store: any, directory: string, options: { customVerifier?: boolean } = {}) {
  const customGrader = { id: "sandbox_exact", version: "1", label: "Sandbox exact match", kind: "custom_verifier" as const, weight: 1, hardGate: true, rewardEligible: false, privileged: true, module: "graders/exact.js", exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" as const, metadata: {} };
  const taskset = tasksetFixture({ ready: true, graders: options.customVerifier ? [customGrader] : undefined });
  const plan = planFixture(taskset);
  const tasksetDirectory = path.join(directory, "training", "tasksets", taskset.id);
  await mkdir(tasksetDirectory, { recursive: true });
  await buildTaskset(taskset, tasksetDirectory, options.customVerifier ? { generatedFiles: [{ path: "graders/exact.js", role: "verifier", content: "export function verify({ task, attempt }) { const passed = attempt.output.text === task.expectedOutput.text; return { score: passed ? 1 : 0, passed, feedback: 'Sandbox verifier executed.' }; }\n" }] } : undefined);
  await store.upsertTaskset(taskset);
  await store.saveTrainingPlan(plan);
  const bundleDirectory = path.join(directory, "training", "bundles", plan.id);
  const bundle = await buildTrainingBundle({ taskset, plan, directory: bundleDirectory });
  await store.saveTrainingBundle(bundle);
  const approval = TrainingApprovalSchema.parse({ schemaVersion: "openpond.trainingApproval.v1", id: "approval_fixture", planId: plan.id, bundleHash: bundle.contentHash, destinationId: "local_cpu_fixture", modelId: plan.recipe.method === "sft" ? plan.recipe.baseModel.id : "unsupported", method: "sft", parameterization: "lora", maximumCostUsd: 0, approvedBy: "local_user", approvedAt: "2026-07-12T00:00:00Z" });
  await store.saveTrainingApproval(approval);
  const destination = new LocalCpuTrainingDestination({ store, storeDir: directory, projectDir: path.resolve("python/openpond-training") });
  return { taskset, plan, bundle, approval, destination };
}

async function waitForTerminal(destination: LocalCpuTrainingDestination, jobId: string) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const job = await destination.status(jobId);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${jobId}.`);
}

function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
