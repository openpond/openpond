import { canonicalJson, contentHash, sha256, ImmutableReleaseRefSchema, HarnessSourceSelectionSchema, validateHarnessSourcePackage, type HarnessSourcePackage, type ImmutableReleaseRef, type VersionedReleaseRef } from "@openpond/harness";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import { HarnessRunManifestContentSchema, HarnessRunManifestSchema, ResolvedTrainingBundleContentSchema, ResolvedTrainingBundleManifestSchema, type ComputeTargetBinding, type HarnessRunManifest, type HarnessRuntimeTargetBinding, type OpaqueSecretLeaseRef, type ResolvedTrainingBundleManifest, type TrainingEngineBinding } from "./training-bundle-contracts.js";
import type { ModelProject } from "./model-projects.js";
import type { Taskset } from "./taskset-authored-contracts.js";
import { computeTasksetHash } from "./taskset-authored-validation.js";
import { resolvePortableTasksetRewardExecution, type TasksetRewardExecution } from "./taskset-authored-portable-release.js";
import { TRAINING_EVALUATION_SOURCE_PATH, TrainingEvaluationSourceSchema, assertTrainingEvaluationIsolation, type TrainingEvaluationSource } from "./training-evaluation-source.js";

export * from "./training-bundle-contracts.js";
export { materializeLearningBatchTaskset, prepareReviewedLearningBatch } from "./training-learning-batch.js";
export { prepareManagedTrainingSubmission, type ManagedTrainingPreparationInput, type TrainingPreparationFile } from "./managed-training-preparation.js";
export { scanAndRedactEvidence, type EvidencePrivacyScan } from "./training-privacy.js";

export type TasksetTrainingBundle = {
  manifest: HarnessRunManifest;
  resolvedBundleManifest: ResolvedTrainingBundleManifest;
  assets: ReadonlyMap<string, Uint8Array>;
  profileRelease: VersionedReleaseRef;
  harnessRelease: ImmutableReleaseRef;
  tasksetRelease: ImmutableReleaseRef;
  datasetRelease: ImmutableReleaseRef;
  evidenceSetRelease: ImmutableReleaseRef | null;
};

/**
 * Produces the one artifact the training worker consumes. The release refs in
 * the manifest are immutable lineage identifiers, not separately materialized
 * release objects.
 */
export function buildTasksetTrainingBundle(input: {
  taskset: Taskset;
  modelProject: ModelProject;
  modelRunId: string;
  runtime: HarnessRuntimeTargetBinding;
  compute: ComputeTargetBinding;
  engine: TrainingEngineBinding;
  approval: {
    approvalHash: string;
    approvedAt: string;
    maximumSpendUsd: number | null;
  };
  secretLeaseRefs?: OpaqueSecretLeaseRef[];
  openpondRelease: string;
  workerProtocol: string;
  harnessRelease: ImmutableReleaseRef;
  tasksetRelease: ImmutableReleaseRef;
  harnessSource?: HarnessSourcePackage | null;
  tasksetAssetBytes?: ReadonlyMap<string, Uint8Array>;
  rewardExecution?: TasksetRewardExecution;
  verifierAssets?: LearningTextAsset[];
  evaluationSource?: TrainingEvaluationSource;
}): TasksetTrainingBundle {
  const { taskset, modelProject, harnessRelease, tasksetRelease } = input;
  const setup = modelProject.trainingSetup;
  const releasedHarness = ImmutableReleaseRefSchema.parse(harnessRelease);
  const releasedTaskset = ImmutableReleaseRefSchema.parse(tasksetRelease);
  // These remain part of the preparation API for adapter compatibility; the
  // selected Harness release is now supplied explicitly and is never rebuilt
  // from mutable Profile/Taskset state here.
  void input.openpondRelease;
  void input.workerProtocol;
  const actualTasksetHash = computeTasksetHash(taskset);
  if (actualTasksetHash !== taskset.contentHash) {
    throw new Error(
      "Taskset authoring state changed after its release was selected.",
    );
  }
  if (
    !setup.baseModel?.revision ||
    !setup.baseModel.tokenizerRevision ||
    !setup.baseModel.chatTemplateHash ||
    !setup.recipe ||
    !setup.tasksetRef ||
    setup.tasksetRef.id !== taskset.id ||
    setup.tasksetRef.contentHash !== taskset.contentHash
  ) {
    throw new Error(
      "Model Run must bind an exact Taskset, Model revision, tokenizer, chat template, and Recipe.",
    );
  }

  const profileRelease = taskset.profileRelease ?? {
    id: `profile_${taskset.profileId}`,
    revision: taskset.revision,
    contentHash: contentHash({
      profileId: taskset.profileId,
      sourceCommit: taskset.authoringProvenance.sourceCommit,
      skillHash: taskset.authoringProvenance.skillHash,
    }),
  };
  const assets = new Map<string, Uint8Array>();
  if (input.evaluationSource) {
    const evaluation = TrainingEvaluationSourceSchema.parse(input.evaluationSource);
    if (contentHash(evaluation.taskset) !== contentHash(setup.evaluationTasksetRef)) {
      throw new Error("The evaluation source differs from the prepared Model configuration.");
    }
    assertTrainingEvaluationIsolation(taskset.tasks.filter(task => task.split === "train"), evaluation.tasks);
    assets.set(TRAINING_EVALUATION_SOURCE_PATH, new TextEncoder().encode(canonicalJson(evaluation)));
  } else if (setup.evaluationTasksetRef) {
    throw new Error("The prepared Model requires its pinned evaluation source bytes.");
  }
  const harnessSource = input.harnessSource
    ? validateHarnessSourcePackage(input.harnessSource, releasedHarness)
    : null;
  if (setup.harnessRelease && !harnessSource) {
    throw new Error("A selected Harness requires its complete immutable source package.");
  }
  if (harnessSource && (!setup.harnessRelease
    || setup.harnessRelease.id !== releasedHarness.id
    || setup.harnessRelease.contentHash !== releasedHarness.contentHash)) {
    throw new Error("Harness source differs from the Model's explicit selection.");
  }
  if (harnessSource) {
    const leavesLocalHost = input.runtime.placement !== "local" || input.compute.kind !== "local";
    if (leavesLocalHost && (!harnessSource.agentSnapshot.portability.portable
      || harnessSource.harnessRelease.files.some(file => file.visibility === "host_private"))) {
      throw new Error("The selected Harness contains source that cannot leave its local host.");
    }
    addJsonAsset(assets, "harness/source-package.json", harnessSource);
  }
  addJsonAsset(assets, "harness/execution.json", HarnessSourceSelectionSchema.parse({
    schemaVersion: "openpond.harnessSourceSelection.v1",
    mode: harnessSource ? "selected_release" : "taskset_owned",
    harnessRelease: releasedHarness,
    sourcePackageHash: harnessSource?.contentHash ?? null,
  }));
  const rewardExecution = resolvePortableTasksetRewardExecution(taskset, input.rewardExecution);
  if (rewardExecution) {
    const verifierAssets = input.verifierAssets ?? [];
    const references = compileBoundGraders(rewardExecution.binding, rewardExecution.rewards)
      .flatMap(grader => grader.kind === "custom_verifier" ? [grader.verifierRef] : []);
    const expected = new Set(references.map(reference => reference.id));
    if (new Set(verifierAssets.map(asset => asset.id)).size !== verifierAssets.length
      || verifierAssets.some(asset => !expected.has(asset.id))) throw new Error("Unexpected or duplicate private verifier asset.");
    for (const reference of references) {
      const asset = verifierAssets.find(asset => asset.id === reference.id);
      if (!asset || reference.visibility !== "verifier") throw new Error("Training bundle requires its private verifier asset.");
      verifyLearningTextAsset(asset, reference);
    }
    addJsonAsset(assets, "reward-binding.json", { kind: "reward_binding_v1", binding: rewardExecution.binding, rewards: rewardExecution.rewards, assets: verifierAssets });
  } else if (input.verifierAssets?.length) {
    throw new Error("Private verifier assets require a published Reward binding.");
  }
  addJsonAsset(assets, "environment.json", {
    schemaVersion: "openpond.harnessEnvironment.v1",
    environment: taskset.environment,
    capabilities: taskset.capabilities,
    policy: taskset.policy,
    outputContract:
      (taskset.metadata.tasksetOutputContract as { mode?: unknown } | undefined)
        ?.mode === "text"
        ? null
        : taskset.metadata.tasksetOutputContract ?? null,
  });
  addJsonAsset(assets, "graders.json", {
    schemaVersion: "openpond.harnessGraders.v1",
    graders: taskset.graders,
    fixtures: taskset.graderFixtures,
  });
  addJsonAsset(assets, "tool-contract.json", {
    schemaVersion: "openpond.harnessToolContract.v1",
    toolNames: taskset.environment.toolNames,
    actionBindings: taskset.environment.actionBindings ?? [],
    capabilities: taskset.capabilities,
    connectedAppScopes: taskset.policy.connectedAppScopes,
  });
  const trainTasks = taskset.tasks.filter((task) => task.split === "train");
  if (trainTasks.length > 0) {
    addJsonAsset(assets, "dataset/train.json", {
      schemaVersion: "openpond.datasetSplit.v1",
      split: "train",
      tasks: trainTasks,
    });
    addTasksetAssets({
      assets,
      tasks: trainTasks,
      tasksetAssetBytes: input.tasksetAssetBytes ?? new Map(),
    });
  } else if (taskset.datasetArtifact) {
    addJsonAsset(assets, "dataset/artifact.json", taskset.datasetArtifact);
  } else {
    throw new Error("Taskset has no training dataset.");
  }

  const approvedSignals = Object.values(taskset.learningSignals)
    .flat()
    .filter((signal) => signal.approved);
  for (const signal of approvedSignals) {
    const value = bytes(signal);
    assets.set(`evidence/signals/${sha256(value)}.json`, value);
  }

  const datasetRelease = {
    id: `dataset_${taskset.id}_r${taskset.revision}`,
    contentHash: contentHash({
      taskset: releasedTaskset,
      sourceRefs: taskset.sourceRefs,
      datasetArtifact: taskset.datasetArtifact ?? null,
      trainTasks,
    }),
  };
  const evidenceSetRelease =
    approvedSignals.length > 0
      ? {
          id: `evidence_${taskset.id}_r${taskset.revision}`,
          contentHash: contentHash({
            taskset: releasedTaskset,
            harnessRelease: releasedHarness,
            datasetRelease,
            profileRelease,
            signals: approvedSignals,
          }),
        }
      : null;

  const bundleContent = ResolvedTrainingBundleContentSchema.parse({
    schemaVersion: "openpond.resolvedTrainingBundle.v1",
    projection: "trainer",
    harnessRelease: releasedHarness,
    datasetRelease,
    evidenceSetRelease,
    files: [...assets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetPath, value]) => ({
        path: assetPath,
        sha256: sha256(value),
        sizeBytes: value.byteLength,
      })),
  });
  const resolvedBundleManifest = ResolvedTrainingBundleManifestSchema.parse({
    ...bundleContent,
    contentHash: contentHash(bundleContent),
  });
  const manifestContent = HarnessRunManifestContentSchema.parse({
    schemaVersion: "openpond.harnessRunManifest.v1",
    id: `manifest_${input.modelRunId}_${input.approval.approvalHash.slice(0, 16)}`,
    harnessRelease,
    datasetRelease,
    evidenceSets: evidenceSetRelease ? [evidenceSetRelease] : [],
    model: {
      source: setup.baseModel.modelId,
      revision: setup.baseModel.revision,
      artifactHash: null,
      tokenizerRevision: setup.baseModel.tokenizerRevision,
      chatTemplateHash: setup.baseModel.chatTemplateHash,
    },
    recipe: {
      method: setup.recipe.method,
      version: "openpond.trainingRecipe.v1",
      configHash: contentHash(setup.recipe),
    },
    runtimeTarget: input.runtime,
    computeTarget: input.compute,
    engine: input.engine,
    resolvedBundleHash: resolvedBundleManifest.contentHash,
    secretLeaseRefs: input.secretLeaseRefs ?? [],
    approval: input.approval,
    createdAt: modelProject.updatedAt,
  });
  const manifest = HarnessRunManifestSchema.parse({
    ...manifestContent,
    contentHash: contentHash(manifestContent),
  });
  return {
    manifest,
    resolvedBundleManifest,
    assets,
    profileRelease,
    harnessRelease: releasedHarness,
    tasksetRelease: releasedTaskset,
    datasetRelease,
    evidenceSetRelease,
  };
}

function addTasksetAssets(input: {
  assets: Map<string, Uint8Array>;
  tasks: Taskset["tasks"];
  tasksetAssetBytes: ReadonlyMap<string, Uint8Array>;
}): void {
  const expected = new Set<string>();
  for (const task of input.tasks) {
    for (const asset of task.assets ?? []) {
      if (expected.has(asset.artifactRef)) {
        throw new Error(
          `Training asset path ${asset.artifactRef} is shared by multiple tasks.`,
        );
      }
      expected.add(asset.artifactRef);
      const value = input.tasksetAssetBytes.get(asset.artifactRef);
      if (!value) {
        throw new Error(
          `Resolved Training Bundle is missing Work asset ${asset.artifactRef}.`,
        );
      }
      if (value.byteLength !== asset.sizeBytes || sha256(value) !== asset.sha256) {
        throw new Error(
          `Resolved Training Bundle Work asset ${asset.artifactRef} failed immutable verification.`,
        );
      }
      input.assets.set(asset.artifactRef, value);
    }
  }
  for (const assetPath of input.tasksetAssetBytes.keys()) {
    if (!expected.has(assetPath)) {
      throw new Error(
        `Resolved Training Bundle received unexpected Work asset ${assetPath}.`,
      );
    }
  }
}

function addJsonAsset(
  assets: Map<string, Uint8Array>,
  assetPath: string,
  value: unknown,
): void {
  assets.set(assetPath, bytes(value));
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}
