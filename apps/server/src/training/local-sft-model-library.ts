import path from "node:path";
import { ModelArtifactLineageSchema, ModelRunSchema, TrainingArtifactSchema, type ModelRun } from "@openpond/contracts";
import { LocalSftApprovalSchema, type LocalSftRun } from "@openpond/contracts/resource-setup";
import { SessionResourceDraftSchema } from "@openpond/contracts/requests";
import { contentHash } from "@openpond/taskset-sdk";
import type { z } from "zod";
import type { SqliteStore } from "../store/store.js";

type Approval = z.infer<typeof LocalSftApprovalSchema>;
type State = NonNullable<LocalSftRun["run"]>["state"];
const statusByPhase = {
  starting: "prepared", running: "running", cancelling: "running",
  completed: "succeeded", failed: "failed", cancelled: "cancelled",
} as const;

export function localSftModelRunId(planHash: string, attemptId: string) {
  return `model_run_local_sft_${contentHash({ planHash, attemptId }).slice(0, 32)}`;
}

export async function projectLocalSftRun(input: {
  store: SqliteStore;
  approval: Approval;
  attemptId: string;
  state: State;
  directory: string;
  startedAt: string;
  observedAt: string;
  completedAt?: string;
}): Promise<ModelRun | null> {
  const { store, approval, state, attemptId, directory, startedAt, observedAt } = input;
  const { sessionId, dataset, recipe, modelAssetId } = approval.request;
  const session = await store.getSession(sessionId);
  const resource = SessionResourceDraftSchema.safeParse(session?.metadata?.resourceDraft);
  if (!resource.success || resource.data.kind !== "model" || session?.systemKind || session?.workspaceKind === "sandbox") return null;
  const project = await store.getModelProject(resource.data.id);
  if (!project || project.profileId !== resource.data.profileId) return null;

  const id = localSftModelRunId(approval.planHash, attemptId);
  const existing = await store.getModelRun(id);
  const localSft = {
    sessionId, attemptId, planHash: approval.planHash, datasetName: approval.datasetName, phase: state.status,
    progress: "device" in state && state.device && state.step !== undefined && state.steps !== undefined
      ? { step: state.step, steps: state.steps, gpuName: state.device.name } : existing?.localSft?.progress,
  };
  const failure = state.status === "failed" ? state.reason : null;
  if (existing && JSON.stringify(existing.localSft) === JSON.stringify(localSft) && existing.failure === failure) return existing;
  const status = statusByPhase[state.status];
  const terminal = status === "cancelled" || status === "failed" || status === "succeeded";
  const completedAt = input.completedAt ?? observedAt;
  const core = {
    schemaVersion: "openpond.modelRun.v1", id, modelVersionId: null, modelId: project.id,
    profileId: project.profileId, kind: "training", status, method: "sft", destinationId: "local_cuda",
    taskset: dataset, quote: { maximumSpendUsd: 0, hourlyCostUsd: null },
    reward: null, localSft, failure, startedAt,
    completedAt: terminal ? completedAt : null, updatedAt: observedAt,
  } as const;
  if (state.status !== "completed") {
    return store.projectLocalSftModelRun(ModelRunSchema.parse({ ...core, receipt: null, adapterArtifactLineageId: null }));
  }

  const base = recipe.baseModel;
  const artifacts = Object.entries(state.files).map(([name, file]) => TrainingArtifactSchema.parse({
    schemaVersion: "openpond.trainingArtifact.v1",
    id: `training_artifact_${contentHash([id, name, file.sha256]).slice(0, 24)}`,
    jobId: id, kind: name.endsWith(".safetensors") ? "adapter" : "manifest",
    path: path.join(directory, "adapter", name), sha256: file.sha256, sizeBytes: file.bytes,
    baseModelId: base.id, baseModelRevision: base.revision, tokenizerRevision: base.tokenizerRevision,
    chatTemplateHash: base.chatTemplateHash, nonProduction: true, createdAt: completedAt,
    metadata: { provider: "local_cuda", providerFilename: name, verified: true, modelAssetId },
  }));
  const weights = artifacts.find(artifact => artifact.kind === "adapter")!;
  const receiptCore = {
    schemaVersion: "openpond.localSftModelRunReceipt.v1", planHash: approval.planHash,
    datasetPackageHash: approval.datasetPackageHash, trainingDataHash: approval.trainingDataHash,
    taskIdsHash: approval.taskIdsHash, tokenizationHash: state.tokens.tokenizationHash,
    adapterHash: weights.sha256, adapterConfigHash: state.files["adapter_config.json"].sha256,
  } as const;
  const receipt = { ...receiptCore, contentHash: contentHash(receiptCore) };
  const lineage = ModelArtifactLineageSchema.parse({
    schemaVersion: "openpond.modelArtifactLineage.v1",
    id: `model_lineage_${contentHash([id, receipt.contentHash]).slice(0, 24)}`,
    modelId: project.id, artifactId: weights.id, jobId: id, tasksetId: dataset.id, tasksetHash: dataset.contentHash,
    graderHash: contentHash([]), planHash: approval.planHash, bundleHash: receipt.contentHash,
    recipeHash: contentHash(recipe), workerVersion: "openpond-local-sft-v1", trainerVersion: "pytorch-peft",
    importedAt: completedAt, frozenEvaluationArtifactId: null, promotable: false,
  });
  return store.projectLocalSftModelRun(ModelRunSchema.parse({ ...core, receipt, adapterArtifactLineageId: lineage.id }), {
    lineage, artifacts,
    version: {
      schemaVersion: "openpond.modelVersion.v1", modelId: project.id, profileId: project.profileId,
      kind: "lora_adapter", status: "available", taskset: dataset, releaseGraph: null,
      localSft: { sessionId, attemptId, planHash: approval.planHash, modelRunId: id },
      baseModel: {
        schemaVersion: "openpond.baseModelPreference.v1", source: "local", modelAssetId,
        modelId: base.id, revision: base.revision, tokenizerRevision: base.tokenizerRevision, chatTemplateHash: base.chatTemplateHash,
      },
      artifactLineageId: lineage.id, adapterStatus: "trained", createdAt: completedAt,
    },
  });
}
