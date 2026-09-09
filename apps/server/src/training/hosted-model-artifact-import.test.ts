import { describe, expect, it, vi } from "vitest";
import { TrainingJobSchema, type ModelArtifactLineage, type ModelBinding, type ModelProject, type TrainingArtifact } from "@openpond/contracts";
import { TrainingJobSubmissionSchema, trainingExecutionReceiptHash, trainingJobSubmissionHash } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { importHostedModelArtifacts } from "./hosted-model-artifact-import.js";
import { assertManagedModelArtifactIntegrity } from "./managed-model-artifact-integrity.js";
import { createTrainingModelBindingService } from "./training-model-binding-service.js";

const H = "a".repeat(64);
const NOW = "2026-09-09T12:00:00.000Z";

async function fixture() {
  const project = { id: "model", profileId: "profile", hosted: { projectId: "hosted-model", teamId: "team", apiOrigin: "https://host.invalid" } } as ModelProject;
  const submission = TrainingJobSubmissionSchema.parse({
    schemaVersion: "openpond.trainingJobSubmission.v2", idempotencyKey: "run-once", name: "Training",
    source: {
      modelProject: { id: "hosted-model", portableProjectId: "model", revision: 1, contentHash: H },
      harnessRunManifest: { id: "manifest", contentHash: H }, harnessRelease: { id: "harness", contentHash: H },
      taskset: { id: "remote-taskset", revision: 1, contentHash: H }, tasksetRelease: { id: "taskset-release", contentHash: H },
      dataset: { id: "dataset", contentHash: H }, evidenceSets: [],
    },
    job: { kind: "policy_optimize", baseModel: { schemaVersion: "openpond.baseModelPreference.v1", source: "managed",
      modelId: "Qwen/Qwen3-8B", revision: H, tokenizerRevision: H, chatTemplateHash: H, modelAssetId: null },
      recipe: { schemaVersion: "openpond.rftRecipe.v1", method: "grpo", parameterization: "lora", reward: { graderHash: H } },
      rewardSource: { kind: "deterministic", grader: { id: "grader", contentHash: H }, composer: null }, resumeFrom: null },
    requestedCapabilities: [], placementObjective: "balanced", budget: { maximumSpendUsd: 2, maximumWallSeconds: 1200 },
    approval: { approvalHash: H, approvedAt: NOW, exportApproved: true, maximumSpendUsd: 2, retentionDays: 7, region: null }, contentHash: H,
  });
  submission.contentHash = await trainingJobSubmissionHash(submission);
  const remote = { schemaVersion: "openpond.trainingJob.v2", id: "job", teamId: "team", kind: "policy_optimize",
    modelProjectId: "hosted-model", portableProjectId: "model", sourceProjectRevision: 1, submissionHash: submission.contentHash,
    state: "succeeded", phase: "completed", version: 1, progress: 1,
    rolloutProgress: { groupsCompleted: 2, groupsTarget: 2, optimizerUpdatesApplied: 2, optimizerUpdatesSkipped: 0 },
    accruedSpendUsd: 0.2, terminalReason: null, createdAt: NOW, updatedAt: NOW, completedAt: NOW };
  const output = (id: string, kind: "adapter" | "evaluation" | "receipt", metadata: Record<string, unknown>) => ({
    schemaVersion: "openpond.trainingJobOutput.v2" as const, id, jobId: "job", kind, artifactRef: `managed-rl://job/${id}`,
    contentHash: H, sizeBytes: 128, metadata, createdAt: NOW,
  });
  const receipt = { schemaVersion: "openpond.trainingExecutionReceipt.v2" as const, id: "receipt", teamId: "team", jobId: "job",
    submissionHash: submission.contentHash, manifestHash: H, recipeHash: H, capabilityHash: H, runtimeRelease: { id: "runtime", contentHash: H },
    inputs: [submission.source.taskset, submission.source.tasksetRelease, submission.source.harnessRelease].map(({ id, contentHash }) => ({ id, contentHash })),
    outputs: [{ id: "adapter", contentHash: H }, { id: "evaluation", contentHash: H }], spendUsd: 0.2, durationSeconds: 60,
    cleanupComplete: true, issuer: "sandbox-managed-training", issuedAt: NOW, signature: null };
  const outputs = { schemaVersion: "openpond.trainingJobOutputs.v2", outputs: [output("adapter", "adapter", { policyVersion: 2 }),
    output("evaluation", "evaluation", { kind: "candidate", policyVersion: 2 }),
    { ...output("receipt-output", "receipt", {}), contentHash: await trainingExecutionReceiptHash(receipt) }], receipt };
  let job = TrainingJobSchema.parse({ schemaVersion: "openpond.trainingJob.v1", id: "job", planId: "hosted:model:r1", bundleHash: H,
    approvalId: H, destinationId: "openpond_managed", status: "succeeded", nonProduction: false, workerPid: null,
    startedAt: NOW, completedAt: NOW, error: null, createdAt: NOW, updatedAt: NOW,
    metadata: { modelProjectId: "model", sourceProjectRevision: 1 } });
  const artifacts = new Map<string, TrainingArtifact>();
  const models = new Map<string, ModelArtifactLineage>();
  let active: ModelBinding | null = null;
  const store = {
    getModelProject: async () => project,
    getTrainingJob: async () => job,
    saveTrainingJob: async (value: typeof job) => (job = value),
    listTrainingArtifacts: async () => [...artifacts.values()],
    saveTrainingArtifact: async (value: TrainingArtifact) => { artifacts.set(value.id, value); return value; },
    getTrainingArtifact: async (id: string) => artifacts.get(id) ?? null,
    listModelArtifactLineage: async () => [...models.values()],
    saveModelArtifactLineage: async (value: ModelArtifactLineage) => { models.set(value.id, value); return value; },
    getModelArtifactLineage: async (id: string) => models.get(id) ?? null,
    getTaskset: async () => null, getTrainingPlan: async () => null, listCreateImproveRuns: async () => [],
    getActiveModelBinding: async () => active,
    replaceActiveModelBinding: async (value: { next: ModelBinding }) => { active = value.next; },
  } as unknown as SqliteStore;
  const access = { teamId: "team", apiBaseUrl: "https://host.invalid", token: "fixture-token" };
  const request = vi.fn(async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/training/jobs/job") return Response.json({ job: remote });
    if (pathname === "/v1/training/jobs/job/outputs") return Response.json(outputs);
    throw new Error(`Unexpected request: ${pathname}`);
  });
  return { project, job, submission, remote, receipt, outputs, store, access, request, artifacts, models };
}

describe("Hosted Model serving receipts", () => {
  // An API-created Model must be bindable without local weights or a downloaded Taskset,
  // and importing it repeatedly must preserve the same Version and evaluation identity.
  it("imports one exact hosted Version and verifies its remote receipt before binding", async () => {
    const f = await fixture();
    await importHostedModelArtifacts({ ...f, fetch: f.request });
    await importHostedModelArtifacts({ ...f, fetch: f.request });
    expect(f.models.size).toBe(1);
    expect(f.artifacts.size).toBe(3);
    const model = [...f.models.values()][0]!;
    expect(model.frozenEvaluationArtifactId).toBe([...f.artifacts.values()].find(value => value.kind === "evaluation")?.id);
    expect([...f.artifacts.values()].every(value => value.path.startsWith("sandbox-managed-rl://job/"))).toBe(true);
    model.managedServing = { schemaVersion: "openpond.managedAdapterServingProjection.v1", teamId: "team", source: "sandbox_managed_rl",
      sourceRef: "job", canonicalArtifactId: "canonical", canonicalArtifactState: "promotable", canonicalDeploymentId: "deployment",
      canonicalDeploymentState: "ready", state: "ready", customerBindingAllowed: true, artifactContentHash: H, baseProfileId: null,
      publishedAt: NOW, lastSyncedAt: NOW, lastError: null };
    vi.stubGlobal("fetch", f.request);
    try {
      const activateManagedBinding = vi.fn(async () => undefined);
      const service = createTrainingModelBindingService({ store: f.store, resolveManagedTrainingAccess: async () => f.access, activateManagedBinding });
      const binding = await service.bindModel({ profileId: "profile", modelId: model.id, role: "chat_manual", roleTargetId: "default" });
      expect(binding.modelArtifactLineageId).toBe(model.id);
      expect(binding.metadata.canonicalSandboxArtifactId).toBe("canonical");
      expect(activateManagedBinding).toHaveBeenCalledOnce();
      await expect(service.bindModel({ profileId: "other", modelId: model.id, role: "chat_manual", roleTargetId: "default" })).rejects.toThrow("active Profile");
    } finally { vi.unstubAllGlobals(); }
  });

  // A stale projection or a matching local pathname must never authorize a foreign,
  // changed or uncleaned remote candidate.
  it("rejects workspace switches, changed outputs and cleanup failures without changing lineage", async () => {
    const f = await fixture();
    await importHostedModelArtifacts({ ...f, fetch: f.request });
    const model = [...f.models.values()][0]!;
    const artifact = f.artifacts.get(model.artifactId)!;
    const verify = () => assertManagedModelArtifactIntegrity({ ...f, profileId: "profile", model, artifact, resolveAccess: async () => f.access, fetch: f.request });
    const saved = JSON.stringify(model);
    f.access.teamId = "other";
    const requests = f.request.mock.calls.length;
    await expect(verify()).rejects.toThrow("different workspace");
    expect(f.request).toHaveBeenCalledTimes(requests);
    f.access.teamId = "team";
    f.remote.portableProjectId = "other";
    await expect(verify()).rejects.toThrow("completed Model run");
    f.remote.portableProjectId = "model";
    f.outputs.outputs[0]!.contentHash = "b".repeat(64);
    await expect(verify()).rejects.toThrow("exact training outputs");
    f.outputs.outputs[0]!.contentHash = H;
    f.receipt.cleanupComplete = false;
    f.outputs.outputs[2]!.contentHash = await trainingExecutionReceiptHash(f.receipt);
    await expect(verify()).rejects.toThrow("cleanup");
    expect(JSON.stringify([...f.models.values()][0])).toBe(saved);
  });
});
