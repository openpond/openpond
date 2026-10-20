import { contentHash } from "@openpond/harness";
import { createRewardBinding, createRewardRelease, compileBoundGraders } from "@openpond/evals/rewards";
import { LearningTextAssetSchema, sealLearningContent } from "@openpond/evals/learning";
import { validateTasksetPackage, decodeTasksetPackageFile, type TasksetPackage } from "./taskset-package-contracts.js";
import { prepareImportedTasksetPackage } from "./taskset-package-projection.js";
import { buildTasksetTrainingBundle } from "./training-bundle.js";
import { prepareManagedTrainingSubmission, type ManagedTrainingPreparationInput } from "./managed-training-preparation.js";
import { deterministicTrainingRewardSource } from "./training-grading-plan.js";
import { TrainingCapabilitiesSchema, type TrainingCapabilities } from "./training.js";
import { qualificationVerifierAssets } from "./training-verifier-assets.js";

export type OrdinaryTasksetQualificationInput = Omit<Parameters<typeof buildTasksetTrainingBundle>[0],
  "taskset" | "executionMode" | "qualificationSource" | "tasksetRelease" | "rewardExecution" | "verifierAssets" | "tasksetAssetBytes" | "evaluationSource" | "approval"> & {
  package: TasksetPackage;
  qualificationTaskId: string;
  approval: ManagedTrainingPreparationInput["approval"] & { approvedAt: string };
  idempotencyKey?: string;
  runtimeCapabilities?: TrainingCapabilities;
};

/** Prepare a no-update original-learner run from the exact published ordinary
 * package, with one explicit source task selected for its rollout group.
 * Splits, families, task IDs and private grader bytes are preserved;
 * this function does not create train/held-out data or approve any source. */
export async function prepareOrdinaryTasksetQualification(input: OrdinaryTasksetQualificationInput) {
  const source = validateTasksetPackage(input.package);
  if (source.taskset.tasks.some(task => task.requiredOutputs?.some(output => output.submissionMode === "structured_json"))) {
    const capabilities = input.runtimeCapabilities && TrainingCapabilitiesSchema.parse(input.runtimeCapabilities);
    if (!capabilities?.structuredOutputs || Date.parse(capabilities.expiresAt) <= Date.now()) {
      throw new Error("Structured qualification requires a current work.structured-output.v1 runtime capability receipt.");
    }
  }
  if (source.modelResources || source.learningResources || !source.taskset.tasks.length) {
    throw new Error("Qualification requires a nonempty ordinary Taskset package.");
  }
  if (source.taskset.tasks.some(task => task.privilegedContextRef !== null || task.artifactRefs.some(asset => asset.visibility !== "policy"))) {
    throw new Error("Qualification runtime requires private targets in expectedOutput and policy-only task assets.");
  }
  const rewards = await Promise.all(source.taskset.graders.map(async grader => {
    const { id, version, weight: _weight, hardGate: _gate, rewardEligible: _eligible, privileged: _private, taskIds: _tasks, ...implementation } = grader;
    const revision = Number(version);
    if (!Number.isSafeInteger(revision) || revision < 1 || String(revision) !== version
      || implementation.kind === "model_judge" || implementation.kind === "human") {
      throw new Error("Qualification requires deterministic graders with canonical integer versions.");
    }
    return createRewardRelease({ schemaVersion: "openpond.rewardRelease.v1", id: `qualification-${contentHash({ source: source.contentHash, id }).slice(0, 40)}`,
      revision, name: id, description: "Exact ordinary package grader for no-update qualification.", implementation,
      rawScore: { minimum: 0, maximum: 1 }, assets: implementation.kind === "custom_verifier" ? await qualificationVerifierAssets(source, implementation.verifierRef) : [] });
  }));
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: `qualification-${source.contentHash.slice(0, 40)}`, revision: 1,
    sources: source.taskset.graders.map((grader, index) => ({ graderId: grader.id, ...(grader.taskIds ? { taskIds: grader.taskIds } : {}),
      reward: { id: rewards[index]!.id, revision: rewards[index]!.revision, contentHash: rewards[index]!.contentHash },
      role: grader.rewardEligible ? "training" : "evaluation", normalization: { kind: "identity" }, weight: grader.weight,
      required: true, hardGate: grader.hardGate, privileged: grader.privileged, fixtureRefs: [] })),
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, rewards);
  if (!binding.sources.some(item => item.role === "training" && item.weight > 0)
    || contentHash(compileBoundGraders(binding, rewards)) !== contentHash(source.taskset.graders)) {
    throw new Error("Qualification must preserve an executable positively weighted source grader set.");
  }
  const verifierIds = new Set(rewards.flatMap(reward => reward.assets.map(asset => asset.id)));
  const verifierAssets = source.files.filter(file => verifierIds.has(file.asset.id)).map(file => LearningTextAssetSchema.parse(sealLearningContent({
    schemaVersion: "openpond.learningTextAsset.v1", id: file.asset.id, revision: 1, asset: file.asset,
    text: new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file)),
  })));
  const { taskset } = prepareImportedTasksetPackage({ package: source, profileId: input.modelProject.id,
    name: source.taskset.id, createdAt: input.modelProject.updatedAt });
  const taskAssets = new Set(taskset.tasks.filter(task => task.id === input.qualificationTaskId)
    .flatMap(task => (task.assets ?? []).map(asset => asset.artifactRef)));
  const tasksetAssetBytes = new Map(source.files.filter(file => taskAssets.has(file.asset.path)).map(file => [file.asset.path, decodeTasksetPackageFile(file)]));
  const tasksetRef = { id: source.taskset.id, revision: source.taskset.revision, contentHash: source.taskset.contentHash };
  const rewardExecution = { binding, rewards };
  const bundle = buildTasksetTrainingBundle({ ...input, taskset, executionMode: "qualification", qualificationSource: source,
    tasksetRelease: { id: tasksetRef.id, contentHash: tasksetRef.contentHash }, rewardExecution, verifierAssets, tasksetAssetBytes,
    approval: { approvalHash: input.approval.approvalHash, approvedAt: input.approval.approvedAt, maximumSpendUsd: input.approval.maximumSpendUsd } });
  const recipe = input.modelProject.trainingSetup.recipe;
  if (!recipe || recipe.method !== "grpo") throw new Error("Qualification requires a pinned GRPO rollout recipe.");
  const prepared = await prepareManagedTrainingSubmission({ executionMode: "qualification", project: input.modelProject,
    manifest: bundle.manifest, bundleManifest: bundle.resolvedBundleManifest, taskset: tasksetRef, recipe,
    files: [...bundle.assets].map(([path, bytes]) => ({ ...bundle.resolvedBundleManifest.files.find(file => file.path === path)!, encoding: "base64" as const, content: Buffer.from(bytes).toString("base64") })),
    rewardSource: await deterministicTrainingRewardSource({ graders: source.taskset.graders, rewardExecution }),
    resumeFrom: null, approval: { approvalHash: input.approval.approvalHash, maximumSpendUsd: input.approval.maximumSpendUsd, retentionDays: input.approval.retentionDays, region: input.approval.region }, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
  return { ...prepared, bundle };
}
