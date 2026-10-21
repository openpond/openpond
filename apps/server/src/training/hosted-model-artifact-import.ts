import {
  ModelArtifactLineageSchema, TrainingArtifactsSchema, TrainingExecutionRefSchema,
  TrainingJobSourceSnapshotSchema, type ModelProject, type TrainingJob,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { parseAndVerifyTrainingJobSubmission } from "openpond-sdk/training";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { candidateEvaluationArtifact, importPortableModelRunArtifacts } from "./portable-model-run-artifacts.js";
import { readManagedTrainingRetainedOutputs, type ManagedTrainingOutputAccess } from "./managed-training-retained-outputs.js";
import type { HostedRecoveryImport } from "./hosted-model-recovery.js";

/** Import hosted candidates into the existing Versions and binding path without a local training launch. */
export async function importHostedModelArtifacts(input: {
  store: SqliteStore;
  project: ModelProject;
  job: TrainingJob;
  submission: unknown;
  recovery?: HostedRecoveryImport;
  access: ManagedTrainingOutputAccess;
  fetch?: typeof fetch;
}): Promise<void> {
  if (input.job.status !== "succeeded") return;
  const submission = await parseAndVerifyTrainingJobSubmission(input.submission);
  const { source } = submission;
  const executionHash = input.recovery?.executionSubmissionHash ?? submission.contentHash;
  if (source.modelProject.portableProjectId !== input.project.id
    || source.modelProject.id !== input.project.hosted?.projectId
    || source.modelProject.revision !== input.job.metadata.sourceProjectRevision) {
    throw new Error("The hosted artifact submission belongs to a different Model revision.");
  }
  const retained = await readManagedTrainingRetainedOutputs({ ...input, jobId: input.job.id,
    expectedSubmissionHash: executionHash, expectedManifestHash: source.harnessRunManifest.contentHash });
  const recovery = input.recovery;
  if (recovery && (retained.job.recovery?.sourceJobId !== recovery.sourceJobId
    || retained.job.recovery.checkpointId !== recovery.checkpointId
    || retained.job.recovery.policyVersion !== recovery.checkpointPolicyVersion
    || retained.job.recovery.completedGroups !== recovery.completedGroups)) {
    throw new Error("The hosted recovery output lost its exact source and checkpoint lineage.");
  }
  const references = recovery ? [source.harnessRunManifest, source.dataset, source.harnessRelease,
    source.evaluation?.taskset ?? source.taskset,
    { id: recovery.sourceJobId, contentHash: recovery.sourceInputManifestSha256 },
    { id: recovery.checkpointId, contentHash: recovery.resumeSha256 },
  ] : [source.taskset, source.tasksetRelease, source.harnessRelease,
    ...(source.evaluation ? [source.evaluation.taskset, source.evaluation.dataset] : [])];
  for (const reference of references) {
    if (!retained.receipt.inputs.some(value => value.id === reference.id && value.contentHash === reference.contentHash)) {
      throw new Error("The hosted execution receipt lost an immutable training or evaluation source.");
    }
  }
  const snapshot = TrainingJobSourceSnapshotSchema.parse({
    schemaVersion: "openpond.trainingJobSourceSnapshot.v1", modelProjectId: input.project.id,
    profileId: input.project.profileId, sourceProjectRevision: source.modelProject.revision,
    taskset: source.taskset, tasksetRelease: source.tasksetRelease, harnessRelease: source.harnessRelease,
    evaluationTasksetRef: source.evaluation?.taskset ?? null, baseModel: submission.job.baseModel,
    method: submission.job.recipe.method,
  });
  const ref = TrainingExecutionRefSchema.parse({
    runId: retained.job.id, providerJobId: retained.job.id, adapterId: "sandbox-managed-rl",
    protocolVersion: "openpond.training.v2", routeFamily: "training_v2", tenantId: input.access.teamId,
    leaseId: null, manifestHash: retained.receipt.manifestHash, inputBundleHash: executionHash,
    createdAt: retained.job.createdAt,
  });
  const portableContent = { runId: retained.job.id, manifestHash: retained.receipt.manifestHash,
    artifacts: retained.outputs.outputs.filter(output => output.kind !== "scorer").map(output => ({
      kind: output.kind, objectRef: `sandbox-managed-rl://${encodeURIComponent(retained.job.id)}/${encodeURIComponent(output.id)}`,
      sha256: output.contentHash, sizeBytes: output.sizeBytes, metadata: output.metadata,
    })) };
  const imported = await importPortableModelRunArtifacts({ store: input.store, job: input.job, source: snapshot,
    executionRef: ref, completedAt: retained.job.completedAt ?? input.job.updatedAt,
    portable: TrainingArtifactsSchema.parse({ ...portableContent, contentHash: contentHash(portableContent) }) });
  let lineageId: string | null = null;
  if (imported.weights) {
    const weights = imported.weights;
    const prior = (await input.store.listModelArtifactLineage()).filter(lineage => lineage.jobId === input.job.id);
    if (prior.length > 1 || prior.some(lineage => lineage.modelId !== input.project.id || lineage.artifactId !== weights.id
      || lineage.tasksetHash !== snapshot.taskset.contentHash)) {
      throw new Error("The imported hosted Version changed its recorded artifact identity.");
    }
    const lineage = prior[0] ?? await input.store.saveModelArtifactLineage(ModelArtifactLineageSchema.parse({
      schemaVersion: "openpond.modelArtifactLineage.v1",
      id: `model_lineage_${contentHash([input.project.id, input.job.id, weights.sha256]).slice(0, 24)}`,
      modelId: input.project.id, artifactId: weights.id, jobId: input.job.id,
      tasksetId: snapshot.taskset.id, tasksetHash: snapshot.taskset.contentHash,
      graderHash: z.object({ graderHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(submission.job.recipe.reward).graderHash,
      // Recovery retains the source approval while its own input manifest binds execution.
      planHash: executionHash, bundleHash: input.job.bundleHash, recipeHash: retained.receipt.recipeHash,
      workerVersion: retained.receipt.runtimeRelease.id,
      trainerVersion: `sandbox-managed-rl@${retained.receipt.runtimeRelease.contentHash}`,
      importedAt: retained.job.completedAt ?? input.job.updatedAt,
      frozenEvaluationArtifactId: candidateEvaluationArtifact(weights, imported.artifacts)?.id ?? null,
      promotable: false, pinned: false, status: "imported", rejectedAt: null, rejectionReason: null, managedServing: null,
    }));
    lineageId = lineage.id;
  }
  const current = await input.store.getTrainingJob(input.job.id);
  if (!current) throw new Error("The hosted run disappeared before artifact import completed.");
  await input.store.saveTrainingJob({ ...current, metadata: { ...current.metadata,
    hostedServingArtifactsImportedForUpdatedAt: input.job.updatedAt,
    hostedSubmissionHash: executionHash, hostedSourceSubmissionHash: submission.contentHash,
    hostedSourceManifestHash: retained.receipt.manifestHash,
    hostedArtifactPlanSource: recovery ? "checkpoint_recovery" : "public_training_submission", sourceSnapshot: snapshot,
    importedModelLineageId: lineageId, adapterArtifactLineageId: lineageId,
  } });
}
