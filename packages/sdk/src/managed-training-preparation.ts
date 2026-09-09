import { contentHash, sha256 } from "@openpond/harness";
import { z } from "zod";

import type { ModelProject } from "./model-projects.js";
import { HarnessRunManifestSchema, ResolvedTrainingBundleManifestSchema, type HarnessRunManifest, type ResolvedTrainingBundleManifest } from "./training-bundle-contracts.js";
import { TRAINING_EVALUATION_SOURCE_PATH, TrainingEvaluationSourceSchema, trainingEvaluationSourceRef, type TrainingEvaluationSource } from "./training-evaluation-source.js";
import { parseAndVerifyTrainingInputArtifactUpload, parseAndVerifyTrainingJobSubmission, trainingInputArtifactUploadHash, trainingJobSubmissionHash, type TrainingJobSubmission } from "./training.js";

type PolicyJob = Extract<TrainingJobSubmission["job"], { kind: "policy_optimize" }>;
export type TrainingPreparationFile = TrainingEvaluationSource["assets"][number];

export interface ManagedTrainingPreparationInput {
  project: ModelProject;
  manifest: HarnessRunManifest;
  recipe: PolicyJob["recipe"];
  taskset: TrainingJobSubmission["source"]["taskset"];
  bundleManifest: ResolvedTrainingBundleManifest;
  files: TrainingPreparationFile[];
  evaluationSource: TrainingEvaluationSource;
  rewardSource: PolicyJob["rewardSource"];
  resumeFrom: PolicyJob["resumeFrom"];
  approval: Pick<TrainingJobSubmission["approval"], "approvalHash" | "maximumSpendUsd" | "retentionDays" | "region">;
  modelImprovementQualification?: { id: string; contentHash: string } | null;
  /** A durable hosted iteration supplies its dispatch identity here. */
  idempotencyKey?: string;
}

/** Build the exact staged artifact and public Job without network or compute.
 * Inputs are copied before hashing so an asynchronous caller cannot rewrite the
 * selected bytes while preparation is in progress.
 */
export async function prepareManagedTrainingSubmission(raw: ManagedTrainingPreparationInput) {
  const input = structuredClone(raw);
  const { project, recipe, taskset, approval } = input;
  const manifest = HarnessRunManifestSchema.parse(input.manifest);
  const bundle = ResolvedTrainingBundleManifestSchema.parse(input.bundleManifest);
  const { contentHash: manifestHash, ...manifestContent } = manifest;
  const { contentHash: bundleHash, ...bundleContent } = bundle;
  if (contentHash(manifestContent) !== manifestHash || contentHash(bundleContent) !== bundleHash
    || manifest.resolvedBundleHash !== bundleHash || contentHash(manifest.harnessRelease) !== contentHash(bundle.harnessRelease)
    || contentHash(manifest.datasetRelease) !== contentHash(bundle.datasetRelease)
    || contentHash(manifest.evidenceSets) !== contentHash(bundle.evidenceSetRelease ? [bundle.evidenceSetRelease] : [])) {
    throw new Error("The managed training manifest or resolved bundle changed.");
  }
  if (!project.hosted || project.hosted.syncedSourceRevision !== project.revision
    || project.hosted.portableProjectId !== project.id) throw new Error("Sync the exact Model Project revision before preparing managed training.");
  const baseModel = project.trainingSetup.baseModel;
  if (!baseModel || baseModel.modelId !== manifest.model.source || baseModel.revision !== manifest.model.revision
    || baseModel.tokenizerRevision !== manifest.model.tokenizerRevision || baseModel.chatTemplateHash !== manifest.model.chatTemplateHash) {
    throw new Error("The synced Model Project base Model does not match the Run manifest.");
  }
  if (recipe.method !== "grpo" || contentHash(recipe) !== manifest.recipe.configHash
    || approval.approvalHash !== manifest.approval.approvalHash || approval.maximumSpendUsd !== manifest.approval.maximumSpendUsd) {
    throw new Error("Managed training requires the exact approved GRPO recipe and spend ceiling.");
  }
  const limits = z.object({ wallTimeMs: z.number().positive() }).parse(recipe.resourceLimits);
  if (input.idempotencyKey !== undefined) z.string().trim().min(16).max(191).parse(input.idempotencyKey);
  const files = verifyFiles(bundle, input.files);
  const evaluationSource = TrainingEvaluationSourceSchema.parse(input.evaluationSource);
  const evaluationFile = files.find(file => file.path === TRAINING_EVALUATION_SOURCE_PATH);
  if (!evaluationFile || contentHash(JSON.parse(Buffer.from(evaluationFile.content, "base64").toString("utf8"))) !== contentHash(evaluationSource)) {
    throw new Error("The evaluation source differs from the immutable training bundle.");
  }
  const evaluation = await trainingEvaluationSourceRef(evaluationSource);
  const payload = {
    schemaVersion: "openpond.managedRlPortableSubmission.v1" as const,
    sourceRunRef: `openpond:model-run:${manifest.id}`,
    name: `OpenPond Managed · ${project.id}`.slice(0, 191),
    idempotencyKey: input.idempotencyKey ?? `openpond-managed:${manifestHash}`.slice(0, 191),
    modelProject: { id: project.hosted.projectId, portableProjectId: project.hosted.portableProjectId },
    manifest, sourceTaskset: taskset,
    modelImprovementQualification: input.modelImprovementQualification ?? null,
    recipe, resolvedBundle: { manifest: bundle, files },
    validationTasks: evaluationSource.tasks, validationAssets: evaluationSource.assets,
  };
  const artifactContent = {
    schemaVersion: "openpond.trainingInputArtifactUpload.v2" as const,
    kind: "portable_training_bundle" as const,
    idempotencyKey: `stage:${input.idempotencyKey ?? manifestHash}`,
    sourceManifest: { id: manifest.id, contentHash: manifestHash }, payload,
  };
  const artifact = await parseAndVerifyTrainingInputArtifactUpload({ ...artifactContent, contentHash: await trainingInputArtifactUploadHash(artifactContent) });
  const jobContent: Omit<TrainingJobSubmission, "contentHash"> = {
    schemaVersion: "openpond.trainingJobSubmission.v2",
    idempotencyKey: input.idempotencyKey ?? `openpond-training-v2:${manifestHash}`,
    name: `OpenPond Managed · ${project.id}`.slice(0, 200),
    source: {
      modelProject: { id: project.hosted.projectId, portableProjectId: project.hosted.portableProjectId, revision: project.revision, contentHash: project.hosted.etag },
      harnessRunManifest: artifactContent.sourceManifest, harnessRelease: manifest.harnessRelease,
      taskset, tasksetRelease: { id: taskset.id, contentHash: taskset.contentHash },
      dataset: bundle.datasetRelease, evaluation,
      evidenceSets: bundle.evidenceSetRelease ? [bundle.evidenceSetRelease] : [],
    },
    job: { kind: "policy_optimize", baseModel, recipe, rewardSource: input.rewardSource, resumeFrom: input.resumeFrom },
    requestedCapabilities: [
      { id: "managed_rl.policy.grpo", version: "1", required: true },
      { id: `managed_rl.rollouts.${manifest.runtimeTarget.placement}`, version: "1", required: true },
      ...(project.trainingSetup.managedGpuRequirement === "h100_hbm3" ? [{ id: "managed_rl.gpu.h100_hbm3", version: "1", required: true }] : []),
    ],
    placementObjective: project.trainingSetup.managedGpuPlacementObjective,
    budget: { maximumSpendUsd: approval.maximumSpendUsd, maximumWallSeconds: Math.ceil(limits.wallTimeMs / 1_000) },
    approval: { ...approval, approvedAt: manifest.approval.approvedAt, exportApproved: true },
  };
  const submission = await parseAndVerifyTrainingJobSubmission({ ...jobContent, contentHash: await trainingJobSubmissionHash(jobContent) });
  return { artifact, submission };
}

function verifyFiles(bundle: ResolvedTrainingBundleManifest, files: TrainingPreparationFile[]) {
  if (files.length !== bundle.files.length || new Set(files.map(file => file.path)).size !== files.length) throw new Error("The managed bundle file inventory changed.");
  const indexed = new Map(files.map(file => [file.path, file]));
  return bundle.files.map(expected => {
    const file = indexed.get(expected.path);
    if (!file || file.path.includes("\\") || file.path.includes("\0") || file.path.split("/").some(part => !part || part === "." || part === "..")
      || file.path === "bundle-manifest.json" || file.encoding !== "base64") throw new Error("The managed bundle contains an invalid file.");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content || file.sha256 !== expected.sha256 || file.sizeBytes !== expected.sizeBytes
      || bytes.byteLength !== expected.sizeBytes || sha256(bytes) !== expected.sha256) throw new Error(`Managed training bundle file ${file.path} changed before upload.`);
    return file;
  });
}
