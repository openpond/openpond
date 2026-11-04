import { contentHash } from "@openpond/harness";
import { LearningDomainError, LearningJsonObjectSchema, LearningSourceSchema, TaskDefinitionSchema,
  TaskEvidenceSchema, TaskFeedbackSchema, assertLearningContentHash, learningEvidenceId, learningRef,
  sameLearningRef, sealLearningContent, taskBatchPackageMetadata, verifyLearningTextAsset,
  type LearningTextAsset } from "@openpond/evals/learning";
import { resolveBoundRewards, compileBoundGraders, type RewardBinding, type RewardRelease } from "@openpond/evals/rewards";
import { validateTaskValue } from "@openpond/evals/task-schema";
import { DatasetTrainingReviewRequestSchema, type DatasetTrainingReviewRequest } from "./dataset-training-review-contracts.js";
import { validateTasksetPackage, resolveTasksetPackageInstructions, decodeTasksetPackageFile, type TasksetPackage } from "./taskset-package-contracts.js";

export function datasetTrainingReviewIdentity(teamId: string, actorId: string, operationId: string) {
  return `dataset-review-${contentHash([teamId, actorId, operationId])}`;
}

/** Pure conversion, never authorization or admission. The host authorizes the
 * exact source, retains its immutable bytes and sharing receipt, then commits
 * new evidence with this graph. It must not expose the retained parent package
 * or unrelated files merely because selected examples become workspace-shared. */
export function prepareDatasetTrainingReview(input: {
  request: DatasetTrainingReviewRequest;
  actorId: string;
  package: TasksetPackage;
  now: string;
  /** For ordinary packages the host derives a stable namespace from the
   * authorized Dataset family, shared by all its published versions. */
  familyNamespace?: string;
  /** A selected saved Reward graph is required for an ordinary package. */
  graph?: { binding: RewardBinding; rewards: RewardRelease[]; assets: LearningTextAsset[] };
}) {
  const request = DatasetTrainingReviewRequestSchema.parse(input.request);
  const value = validateTasksetPackage(input.package);
  if (value.contentHash !== request.packageHash || !sameLearningRef(learningRef(value.taskset), request.dataset))
    throw new LearningDomainError("dataset_review_source_mismatch", 409);
  const id = datasetTrainingReviewIdentity(request.teamId, input.actorId, request.operationId);
  const parent = value.learningResources ? taskBatchPackageMetadata(value.taskset) : null;
  const parentDefinition = parent?.definition ?? value.modelResources?.taskDefinition;
  const retainedGraph = parent ? { binding: parent.binding, rewards: parent.rewards, assets: value.learningResources!.assets }
    : value.modelResources ? { binding: value.modelResources.rewardBinding, rewards: value.modelResources.rewards, assets: value.modelResources.assets } : null;
  const graph = input.graph ?? retainedGraph;
  if (!graph) throw new LearningDomainError("dataset_review_reward_required", 422, "Select an exact saved Reward binding before importing this Dataset for review.");
  const requestedBinding = request.rewardBindingRef ?? retainedGraph?.binding;
  if (!requestedBinding || !sameLearningRef(learningRef(graph.binding), requestedBinding))
    throw new LearningDomainError("dataset_review_reward_mismatch", 409);
  for (const resource of [graph.binding, ...graph.rewards, ...graph.assets]) assertLearningContentHash(resource);
  resolveBoundRewards(graph.binding, graph.rewards);
  const assetRefs = graph.rewards.flatMap(reward => [...reward.assets,
    ...("verifierRef" in reward.implementation ? [reward.implementation.verifierRef] : []),
    ...("rubricRef" in reward.implementation ? [reward.implementation.rubricRef] : []),
    ...("inputContract" in reward.implementation ? [reward.implementation.inputContract] : []),
  ]);
  const assets = [...new Map(assetRefs.map(ref => {
    const asset = graph.assets.find(item => item.id === ref.id);
    if (!asset || ref.visibility === "policy") throw new LearningDomainError("dataset_review_reward_asset_missing", 422);
    verifyLearningTextAsset(asset, ref);
    const original = value.files.find(file => file.asset.id === ref.id);
    if (original && contentHash(original.asset) !== contentHash(ref))
      throw new LearningDomainError("dataset_review_asset_conflict", 409);
    return [asset.id, asset] as const;
  })).values()];
  const selected = request.taskIds ? new Set(request.taskIds) : null;
  const tasks = value.taskset.tasks.filter(task => !selected || selected.has(task.id));
  if (!tasks.length || tasks.length > 10_000 || selected && tasks.length !== selected.size)
    throw new LearningDomainError("dataset_review_selection_mismatch", 409);
  if (request.targetSource === "approved_parent" && !value.learningResources)
    throw new LearningDomainError("dataset_review_parent_targets_unavailable", 422);
  const familyNamespace = parentDefinition?.familyNamespace ?? input.familyNamespace;
  if (!familyNamespace)
    throw new LearningDomainError("dataset_review_family_required", 422, "Resolve the Dataset's stable family before importing its versions.");
  const instructions = request.definition.instructions ?? parentDefinition?.instructions ?? resolveTasksetPackageInstructions(value);
  if (!instructions.trim())
    throw new LearningDomainError("dataset_review_instructions_required", 422, "Provide the task instructions before importing this Dataset.");
  const outputContract = value.taskset.metadata.tasksetOutputContract;
  const ordinaryOutput = outputContract && typeof outputContract === "object" && !Array.isArray(outputContract)
    && "mode" in outputContract && outputContract.mode === "structured_json" && "jsonSchema" in outputContract
    ? LearningJsonObjectSchema.parse(outputContract.jsonSchema) : null;
  const outputSchema = request.definition.outputSchema ?? parentDefinition?.outputSchema ?? ordinaryOutput;
  if (!outputSchema)
    throw new LearningDomainError("dataset_review_output_contract_required", 422, "Provide the actual output contract for this Dataset; importing does not infer a target schema.");
  // Parent verifier-set qualifications describe different evidence. The batch
  // exporter later binds its own exact execution releases, as in Model review.
  const { environmentRelease: _environment, verifierSetRelease: _verifiers, ...execution } = value.taskset;
  const definition = TaskDefinitionSchema.parse(sealLearningContent({
    schemaVersion: "openpond.taskDefinition.v1", id: `${id}-definition`, revision: 1,
    name: request.definition.name ?? parentDefinition?.name ?? value.taskset.id,
    description: parentDefinition?.description ?? "", instructions,
    category: parentDefinition?.category ?? "custom", familyNamespace,
    inputSchema: request.definition.inputSchema ?? parentDefinition?.inputSchema ?? { type: "object" }, outputSchema,
    ...(request.definition.requiredOutputs ?? parentDefinition?.requiredOutputs
      ? { requiredOutputs: request.definition.requiredOutputs ?? parentDefinition?.requiredOutputs } : {}),
    ...(parentDefinition?.contextRequirements ? { contextRequirements: parentDefinition.contextRequirements } : {}),
    harness: parentDefinition?.harness ?? null, rewardBinding: learningRef(graph.binding),
    execution: { policy: { ...execution.policy, hiddenGraderRefs: compileBoundGraders(graph.binding, graph.rewards).filter(grader => grader.privileged).map(grader => grader.id) },
      environment: execution.environment, tools: execution.tools, capabilities: execution.capabilities },
  }));
  const source = LearningSourceSchema.parse(sealLearningContent({
    schemaVersion: "openpond.learningSource.v1", id, revision: 1, name: `${definition.name.slice(0, 480)} review`,
    kind: "direct", taskDefinition: learningRef(definition), enabled: true,
    allowedSplits: [...new Set(tasks.map(task => task.split))], mapping: null, adapterVersion: null,
    datasetOrigin: { receiptId: id, packageHash: value.contentHash, taskset: learningRef(value.taskset) },
  }));
  const parents = new Map(value.learningResources?.evidence.map(item => [item.id, item]) ?? []);
  const decisions = new Map(value.learningResources?.decisions.map(item => [contentHash(item.evidence), item]) ?? []);
  const evidence = tasks.map(task => {
    const original = parents.get(task.id);
    const evaluatorContext = original?.submission.evaluatorContext ?? readPrivateContext(value, task.privilegedContextRef);
    const policyVisibleContext = { ...task.policyVisibleContext,
      ...(request.definition.instructions === undefined ? {} : { instructions: definition.instructions }) };
    const changedPolicy = request.definition.instructions !== undefined
      && request.definition.instructions !== parentDefinition?.instructions;
    return TaskEvidenceSchema.parse(sealLearningContent({
      schemaVersion: "openpond.taskEvidence.v1",
      id: learningEvidenceId(source.id, task.id, `dataset-${value.contentHash}`), revision: 1,
      source: learningRef(source), supersedes: original ? learningRef(original) : null,
      correctionFeedbackId: null, receivedAt: input.now,
      submission: { schemaVersion: "openpond.taskExample.v1", sourceId: source.id,
        idempotencyKey: `${id}-${contentHash(task.id)}`, taskDefinition: learningRef(definition),
        exampleId: task.id, attemptId: `dataset-${value.contentHash}`,
        occurredAt: original?.submission.occurredAt ?? input.now, familyKey: task.clusterKey,
        split: task.split, input: task.input, policyVisibleContext,
        observedOutput: !changedPolicy && original ? original.submission.observedOutput : null,
        expected: task.expectedOutput, evaluatorContext, assets: task.artifactRefs,
        ...(task.requiredOutputs ? { requiredOutputs: task.requiredOutputs } : {}),
        provenance: { sourceRecordRef: JSON.stringify({ dataset: request.dataset, taskId: task.id }),
          mappingHash: contentHash({ schemaVersion: "openpond.datasetTrainingReviewMapping.v1", dataset: request.dataset, packageHash: value.contentHash }) },
      },
    }));
  });
  const proposals = evidence.flatMap(item => {
    const original = parents.get(item.submission.exampleId);
    const target = request.targetSource === "expected_output" ? item.submission.expected
      : request.targetSource === "approved_parent" && original ? decisions.get(contentHash(learningRef(original)))?.approvedTarget ?? null : null;
    if (target === null) return [];
    if (!validateTaskValue(definition.outputSchema, target).valid)
      throw new LearningDomainError("dataset_review_target_schema_mismatch", 422, "A proposed Dataset target differs from the selected output contract. Import without proposals or provide the matching contract.");
    return [TaskFeedbackSchema.parse({
      schemaVersion: "openpond.taskFeedbackRecord.v1", id: `feedback-${contentHash([source.id, item.id])}`, revision: 1,
      submission: { schemaVersion: "openpond.taskFeedback.v1", sourceId: source.id,
        idempotencyKey: `${source.id}-${contentHash(item.id)}`, exampleId: item.submission.exampleId,
        attemptId: item.submission.attemptId, expectedEvidenceHash: item.contentHash,
        occurredAt: input.now, kind: "target_correction", value: target,
        note: "Dataset target proposal. Grade and review this exact evidence before admission." },
      status: "pending_review", evidence: learningRef(item), createdAt: input.now, review: null,
    })];
  });
  return { id, request, source, definition, binding: graph.binding, rewards: graph.rewards, assets, evidence, proposals };
}

function readPrivateContext(value: TasksetPackage, id: string | null) {
  if (!id) return null;
  const file = value.files.find(item => item.asset.id === id);
  if (!file || file.asset.visibility !== "host_private") throw new LearningDomainError("dataset_review_private_context_missing", 422);
  try {
    return LearningJsonObjectSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file))));
  } catch {
    throw new LearningDomainError("dataset_review_private_context_unsupported", 422, "This Dataset's private context is not an object envelope supported by the review engine.");
  }
}
