import { createHash } from "node:crypto";
import { TasksetSchema, type GeneratedTaskFile, type Taskset } from "@openpond/contracts";
import { assertLearningContentHash, learningRef, learningResourceSchemas, sameLearningRef, sealLearningContent, verifyLearningTextAsset, type LearningResourceFor, type LearningTextAsset } from "@openpond/evals/learning";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { TaskRecordSchema, TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { computeTasksetHash, learningVerifierModule, projectLearningBatchGraders, publishTasksetDraft, tasksetDraftFromTaskset } from "@openpond/taskset-sdk";
import { ModelProjectSchema, ModelProjectVersionedRefSchema, OpenPondModelProjectApiError, parseModelProjectSaveRequest, type ModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { createModelStarterExecutionAsset, deriveModelTaskset, ModelStarterExecutionSchema, ModelTasksetPackageSchema, modelStarterExecutionAssetId, type ModelTasksetPackage } from "openpond-sdk/model-starters";
import { canonicalJson } from "openpond-sdk/training";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { importStarterReleaseInTransaction } from "./store-starter-release-import.js";

export interface PreparedModelTaskset {
  taskset: Taskset;
  generatedFiles: GeneratedTaskFile[];
  directoryId: string;
  source: Taskset;
  sourcePackage: ModelTasksetPackage;
  derived: ModelTasksetPackage;
}

/** Runs inside the serialized write queue, before filesystem materialization.
 * The preparation timestamp survives failures without exposing a Model change. */
export function prepareModelTasksetSave(db: OpenPondSqliteConnection, raw: ModelProjectSaveRequest, persistPreparation = true): PreparedModelTaskset | null {
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
  const bindingRef = source.metadata.rewardBinding === undefined ? null : ModelProjectVersionedRefSchema.parse(source.metadata.rewardBinding);
  if (bindingRef && sameLearningRef(bindingRef, project.trainingSetup.rewardBindingRef)) return null;
  if (!bindingRef || source.metadata.learning !== undefined) fail(422, "model_taskset_derivation_unavailable", "This Taskset needs an authored task definition and Reward binding before its Reward can be changed.");
  const read = <K extends "asset" | "definition" | "binding" | "reward">(kind: K, ref: { id: string; revision: number; contentHash?: string }): LearningResourceFor<K> => {
    const row = db.get<{ payload: string }>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [project.profileId, kind, ref.id, ref.revision]);
    if (!row) fail(404, "model_reward_unavailable", `The exact ${kind} resource is unavailable in this Profile.`);
    const resource = learningResourceSchemas[kind].parse(JSON.parse(row.payload));
    assertLearningContentHash(resource);
    if (ref.contentHash && resource.contentHash !== ref.contentHash) fail(409, "model_reward_changed", "The selected resource does not match its immutable content hash.");
    return resource as LearningResourceFor<K>;
  };
  const taskDefinition = read("definition", ModelProjectVersionedRefSchema.parse(source.metadata.taskDefinition));
  if (canonicalJson(source.policy) !== canonicalJson(taskDefinition.execution.policy) ||
      canonicalJson(source.environment.metadata.portableEnvironment) !== canonicalJson(taskDefinition.execution.environment) ||
      canonicalJson(source.environment.metadata.portableTools) !== canonicalJson(taskDefinition.execution.tools)) fail(409, "model_taskset_context_changed", "Taskset context differs from its immutable task definition.");
  const rewardBinding = read("binding", bindingRef);
  const rewards = [...new Map(rewardBinding.sources.map(check => [canonicalJson(check.reward), read("reward", check.reward)])).values()];
  if (source.metadata.rewardExecution !== undefined && canonicalJson(source.metadata.rewardExecution) !== canonicalJson({ binding: rewardBinding, rewards })) fail(409, "model_taskset_rewards_changed", "Taskset embedded Rewards differ from their immutable binding.");
  const selectedBinding = read("binding", project.trainingSetup.rewardBindingRef);
  const selectedRewards = [...new Map(selectedBinding.sources.map(check => [canonicalJson(check.reward), read("reward", check.reward)])).values()];
  const assets = new Map<string, LearningTextAsset>();
  const addAsset = (id: string) => { if (!assets.has(id)) assets.set(id, read("asset", { id, revision: 1 })); };
  for (const reward of [...rewards, ...selectedRewards]) {
    const implementation = reward.implementation;
    for (const ref of [...reward.assets, ...("verifierRef" in implementation ? [implementation.verifierRef] : []), ...("rubricRef" in implementation ? [implementation.rubricRef] : []), ...("inputContract" in implementation ? [implementation.inputContract] : [])]) addAsset(ref.id);
  }
  let execution: ModelTasksetPackage["execution"];
  const executionResources = ModelTasksetPackageSchema.shape.executionResources.parse(source.environment.metadata.portableExecutionResources);
  if (taskDefinition.execution.environment.entrypoint === "openpond.javascript-environment.v1") {
    const asset = read("asset", { id: modelStarterExecutionAssetId(taskDefinition.execution), revision: 1 });
    execution = ModelStarterExecutionSchema.parse(JSON.parse(verifyLearningTextAsset(asset, asset.asset)));
    for (const ref of [execution.javascript.module, execution.environment.actionSchemaRef, execution.environment.observationSchemaRef, execution.environment.stateSchemaRef]) if (ref) addAsset(ref.id);
  }
  for (const task of source.tasks) if (task.privilegedContextRef) addAsset(task.privilegedContextRef);
  if (canonicalJson(source.graders) !== canonicalJson(projectLearningBatchGraders(rewardBinding, rewards, [...assets.values()]))) fail(409, "model_taskset_graders_changed", "Taskset graders differ from their immutable Reward binding.");
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({
    schemaVersion: "openpond.tasksetRelease.v2", id: source.id, revision: source.revision,
    ...taskDefinition.execution, graders: compileBoundGraders(rewardBinding, rewards),
    tasks: source.tasks.map(task => TaskRecordSchema.parse({ id: task.id, clusterKey: task.clusterKey, split: task.split, input: task.input, expectedOutput: task.expectedOutput, policyVisibleContext: task.policyVisibleContext, privilegedContextRef: task.privilegedContextRef, artifactRefs: [], tags: task.tags })),
    metadata: source.metadata.derivedPortableMetadata ?? { localSource: learningRef(source), starter: { taskDefinition: learningRef(taskDefinition), rewardBinding: bindingRef } },
  }));
  const sourcePackage = { taskset, taskDefinition, rewardBinding, rewards, assets: [...assets.values()], ...(executionResources ? { executionResources } : {}), ...(execution ? { execution } : {}) };
  const derived = deriveModelTaskset({ owner: { scopeId: project.profileId, modelId: project.id }, source: sourcePackage, rewardBinding: selectedBinding, rewards: selectedRewards, assets: [...assets.values()] });
  const hash = createHash("sha256").update(canonicalJson(request)).digest("hex");
  if (persistPreparation) db.run("INSERT OR IGNORE INTO model_project_taskset_preparations (profile_id, operation_id, request_hash, created_at, state) VALUES (?, ?, ?, ?, 'preparing')", [project.profileId, request.operationId, hash, new Date().toISOString()]);
  const preparation = db.get<{ request_hash: string; created_at: string }>("SELECT request_hash, created_at FROM model_project_taskset_preparations WHERE profile_id = ? AND operation_id = ?", [project.profileId, request.operationId]) ?? { request_hash: hash, created_at: new Date().toISOString() };
  if (preparation.request_hash !== hash) fail(409, "model_operation_conflict", "This save operation was already used with different Model configuration.");
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
  if (published.revision !== derived.taskset.revision) throw new Error("Derived local and portable Taskset revisions differ.");
  return { taskset: published, generatedFiles, directoryId, source, sourcePackage, derived };
}

/** The caller owns the Model CAS transaction. No filesystem writes happen here. */
export function commitPreparedModelTaskset(db: OpenPondSqliteConnection, request: ModelProjectSaveRequest, prepared: PreparedModelTaskset) {
  const scope = request.project.profileId;
  for (const packageValue of [prepared.sourcePackage, prepared.derived]) {
    importStarterReleaseInTransaction(db, scope, "package", packageValue.taskset);
    importStarterReleaseInTransaction(db, scope, "definition", packageValue.taskDefinition);
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
