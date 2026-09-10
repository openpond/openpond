import { createHash } from "node:crypto";
import { TasksetSchema, type GeneratedTaskFile, type Taskset } from "@openpond/contracts";
import { assertLearningContentHash, learningRef, sameLearningRef, sealLearningContent, TaskBatchPackageMetadataSchema, verifyLearningTextAsset } from "@openpond/evals/learning";
import { resolveBoundRewards } from "@openpond/evals/rewards";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { computeTasksetHash, learningVerifierModule, projectLearningBatchGraders, publishTasksetDraft, tasksetDraftFromTaskset } from "@openpond/taskset-sdk";
import { ModelProjectSchema, ModelProjectVersionedRefSchema, OpenPondModelProjectApiError, parseModelProjectSaveRequest, type ModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { createModelStarterExecutionAsset, deriveModelTaskset, ModelTasksetDerivationSchema, type ModelTasksetPackage } from "openpond-sdk/model-starters";
import { createTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";
import { prepareImportedTasksetPackage, type PreparedImportedTasksetPackage } from "../training/taskset-package-import.js";
import { canonicalJson } from "openpond-sdk/training";
import { createModelTasksetExecutionResourcesAsset } from "openpond-sdk/model-starters";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { importStarterReleaseInTransaction } from "./store-starter-release-import.js";
import { readModelTasksetSource } from "./store-model-taskset-source.js";

export interface PreparedModelTaskset {
  taskset: Taskset;
  generatedFiles: GeneratedTaskFile[];
  directoryId: string;
  source: Taskset;
  sourcePackage: ModelTasksetPackage;
  derived: ModelTasksetPackage;
  imported?: PreparedImportedTasksetPackage;
}

/** Reviewed snapshots remain owned by their Taskset, including after import. */
export function reviewedTasksetRewardBinding(taskset: Taskset | null | undefined) {
  if (taskset?.metadata.learning === undefined) return null;
  const learning = TaskBatchPackageMetadataSchema.parse(taskset.metadata.learning);
  assertLearningContentHash(learning.definition);
  resolveBoundRewards(learning.binding, learning.rewards);
  if (!sameLearningRef(learning.definition.rewardBinding, learningRef(learning.binding))) fail(409, "model_batch_binding_changed", "Reviewed task definition and Reward binding do not match.");
  return learning.binding;
}

/** Runs inside the serialized write queue, before filesystem materialization.
 * The preparation timestamp survives failures without exposing a Model change. */
export function prepareModelTasksetSave(db: OpenPondSqliteConnection, raw: ModelProjectSaveRequest, persistPreparation = true, completeSource?: TasksetPackage): PreparedModelTaskset | null {
  const request = parseModelProjectSaveRequest(raw);
  const { project } = request;
  const modelRow = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ?", [project.id]);
  const model = modelRow ? ModelProjectSchema.parse(JSON.parse(modelRow.payload)) : null;
  if (model && model.profileId !== project.profileId) fail(404, "model_not_found", "Model is not available in this Profile.");
  if ((model?.revision ?? 0) !== request.expectedRevision) fail(409, "model_revision_conflict", "Model changed since it was opened. Refresh before saving.");
  const reference = project.trainingSetup.tasksetRef;
  if (!reference || !project.trainingSetup.rewardBindingRef) return null;
  const row = db.get<{ payload: string }>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND revision = ?", [reference.id, reference.revision]);
  const source = row ? TasksetSchema.parse(JSON.parse(row.payload)) : null;
  if (!source || source.profileId !== project.profileId) fail(404, "model_taskset_not_found", "The selected Taskset revision is not available in this Profile.");
  if (source.contentHash !== reference.contentHash || computeTasksetHash(source) !== source.contentHash) fail(409, "model_taskset_changed", "The selected Taskset does not match its immutable content hash.");
  const reviewedBinding = reviewedTasksetRewardBinding(source);
  if (reviewedBinding) {
    if (!sameLearningRef(learningRef(reviewedBinding), project.trainingSetup.rewardBindingRef)) fail(422, "model_batch_reward_review_required", "Changing a reviewed batch's Reward requires regrading and a new reviewed batch.");
    return null;
  }
  const bindingRef = source.metadata.rewardBinding === undefined ? null : ModelProjectVersionedRefSchema.parse(source.metadata.rewardBinding);
  if (bindingRef && sameLearningRef(bindingRef, project.trainingSetup.rewardBindingRef)) return null;
  if (!bindingRef) fail(422, "model_taskset_derivation_unavailable", "This Taskset needs an authored task definition and Reward binding before its Reward can be changed.");
  const { sourcePackage, selectedBinding, selectedRewards, assets } = readModelTasksetSource(db, source, project.trainingSetup.rewardBindingRef, completeSource);
  const lineage = ModelTasksetDerivationSchema.safeParse(sourcePackage.taskset.metadata.modelTasksetDerivation);
  const linked = model?.hosted?.apiOrigin && model.hosted.tasksets.some(link => {
    if (!lineage.success || link.localTasksetId !== source.id || !link.packageHash || !link.localTasksetHash) return false;
    const localRow = db.get<{ payload: string }>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND content_hash = ? AND profile_id = ?", [source.id, link.localTasksetHash, project.profileId]);
    const pinnedLocal = localRow ? TasksetSchema.parse(JSON.parse(localRow.payload)) : null;
    if (!pinnedLocal || pinnedLocal.contentHash !== link.localTasksetHash) return false;
    const row = db.get<{ payload: string }>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = 'package' AND id = ? AND revision = ?", [project.profileId, link.releaseId, link.releaseRevision]);
    const pinned = row ? TasksetReleaseSchema.parse(JSON.parse(row.payload)) : null;
    const declared = ModelTasksetDerivationSchema.safeParse(pinned?.metadata.modelTasksetDerivation);
    return pinned?.contentHash === link.releaseHash && declared.success && canonicalJson(declared.data.owner) === canonicalJson(lineage.data.owner) && sameLearningRef(declared.data.root, lineage.data.root);
  });
  const owner = linked && lineage.success && lineage.data.owner.modelId === project.id ? lineage.data.owner : { scopeId: project.profileId, modelId: project.id };
  const derived = deriveModelTaskset({ owner, source: sourcePackage, rewardBinding: selectedBinding, rewards: selectedRewards, assets: [...assets.values()] });
  const hash = createHash("sha256").update(canonicalJson(request)).digest("hex");
  if (persistPreparation) db.run("INSERT OR IGNORE INTO model_project_taskset_preparations (profile_id, operation_id, request_hash, created_at, state) VALUES (?, ?, ?, ?, 'preparing')", [project.profileId, request.operationId, hash, new Date().toISOString()]);
  const preparation = db.get<{ request_hash: string; created_at: string }>("SELECT request_hash, created_at FROM model_project_taskset_preparations WHERE profile_id = ? AND operation_id = ?", [project.profileId, request.operationId]) ?? { request_hash: hash, created_at: new Date().toISOString() };
  if (preparation.request_hash !== hash) fail(409, "model_operation_conflict", "This save operation was already used with different Model configuration.");
  if (completeSource) {
    const files = new Map(completeSource.files.map(file => [file.asset.id, file]));
    for (const asset of derived.assets) files.set(asset.id, { asset: asset.asset, base64: Buffer.from(asset.text).toString("base64") });
    const { taskset: derivedRelease, executionResources: resources, ...modelResources } = derived;
    if (!resources) throw new Error("Derived imported package is missing execution resources.");
    const value = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: derivedRelease, ...resources, modelResources, files: [...files.values()] });
    const imported = prepareImportedTasksetPackage({ package: value, profileId: project.profileId, name: source.name, createdAt: preparation.created_at });
    return { taskset: imported.taskset, generatedFiles: imported.generatedFiles, directoryId: String(imported.taskset.environment.metadata.runtimeSourceTasksetId), source, sourcePackage, derived, imported };
  }
  const directoryId = `${derived.taskset.id}-r${derived.taskset.revision}-${sealLearningContent({ packageHash: derived.taskset.contentHash, preparedAt: preparation.created_at }).contentHash}`;
  const draft = tasksetDraftFromTaskset(source, preparation.created_at);
  const portableTasks = new Map(derived.taskset.tasks.map(task => [task.id, task]));
  const generatedFiles: GeneratedTaskFile[] = [];
  for (const grader of derived.taskset.graders) if (grader.kind === "custom_verifier") {
    const path = learningVerifierModule(grader.verifierRef.contentHash);
    if (!generatedFiles.some(file => file.path === path)) generatedFiles.push({ path, role: "verifier", content: verifyLearningTextAsset(assets.get(grader.verifierRef.id)!, grader.verifierRef) });
  }
  const published = publishTasksetDraft({ tasksetId: derived.taskset.id, now: preparation.created_at, sourcePackageHash: derived.taskset.contentHash, draft: {
    ...draft, policy: derived.taskset.policy,
    tasks: draft.tasks.map(task => ({ ...task, metadata: { ...task.metadata, portableTaskRecord: portableTasks.get(task.id) } })),
    environment: { ...draft.environment, metadata: { ...draft.environment.metadata, runtimeSourceTasksetId: directoryId, portableExecutionResources: derived.executionResources } },
    graders: projectLearningBatchGraders(selectedBinding, selectedRewards, [...assets.values()]),
    learningSignals: { ...draft.learningSignals, rewards: draft.learningSignals.rewards.map(signal => ({ ...signal, rules: [{ id: selectedBinding.id, points: 1, condition: "Execute the published Reward binding with its declared normalization, weights and required gates." }], artifactRef: selectedBinding.id, metadata: { ...signal.metadata, rewardBinding: learningRef(selectedBinding) } })) },
    metadata: { ...draft.metadata, portableCapabilities: derived.taskset.capabilities, taskDefinition: learningRef(derived.taskDefinition), rewardBinding: learningRef(selectedBinding), rewardExecution: { binding: selectedBinding, rewards: selectedRewards }, derivedPortableMetadata: derived.taskset.metadata, modelTasksetDerivation: derived.taskset.metadata.modelTasksetDerivation },
  } });
  // Reward edits preserve the exact source metric, including its absence.
  published.metrics = derived.taskset.metrics;
  published.contentHash = computeTasksetHash(published);
  if (published.revision !== derived.taskset.revision) throw new Error("Derived local and portable Taskset revisions differ.");
  return { taskset: published, generatedFiles, directoryId, source, sourcePackage, derived };
}

/** The caller owns the Model CAS transaction. No filesystem writes happen here. */
export function commitPreparedModelTaskset(db: OpenPondSqliteConnection, request: ModelProjectSaveRequest, prepared: PreparedModelTaskset) {
  const scope = request.project.profileId;
  for (const packageValue of [prepared.sourcePackage, prepared.derived]) {
    importStarterReleaseInTransaction(db, scope, "package", packageValue.taskset);
    importStarterReleaseInTransaction(db, scope, "definition", packageValue.taskDefinition);
    const resources = packageValue.executionResources ?? packageValue.execution;
    if (resources) importStarterReleaseInTransaction(db, scope, "asset", createModelTasksetExecutionResourcesAsset(resources));
    if (packageValue.execution) importStarterReleaseInTransaction(db, scope, "asset", createModelStarterExecutionAsset(packageValue.execution));
  }
  const taskset = prepared.taskset;
  const existing = db.get<{ content_hash: string }>("SELECT content_hash FROM taskset_revisions WHERE taskset_id = ? AND revision = ?", [taskset.id, taskset.revision]);
  if (existing) fail(409, "model_taskset_revision_conflict", "The derived Taskset revision was already published. Refresh before saving.");
  const payload = JSON.stringify(taskset);
  db.run("INSERT INTO tasksets (id, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at", [taskset.id, scope, taskset.status, payload, taskset.createdAt, taskset.updatedAt]);
  db.run("INSERT INTO taskset_revisions (taskset_id, revision, content_hash, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [taskset.id, taskset.revision, taskset.contentHash, scope, taskset.status, payload, taskset.createdAt, taskset.updatedAt]);
  db.run("UPDATE model_project_taskset_preparations SET state = 'committed' WHERE profile_id = ? AND operation_id = ?", [scope, request.operationId]);
}

function fail(status: number, code: string, message: string): never {
  throw new OpenPondModelProjectApiError(status, { schemaVersion: "openpond.modelProjectApiError.v2", code, message, retryable: false, requestId: null, details: {} });
}
