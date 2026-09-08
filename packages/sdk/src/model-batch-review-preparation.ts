import { contentHash } from "@openpond/harness";
import { LearningDomainError, LearningSourceSchema, TaskDefinitionSchema, TaskEvidenceSchema, TaskFeedbackSchema,
  assertLearningContentHash, learningEvidenceId, learningRef, sameLearningRef, sealLearningContent,
  taskBatchPackageMetadata, verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import { compileBoundGraders, createRewardBinding, createRewardRelease, resolveBoundRewards, type RewardBinding, type RewardRelease } from "@openpond/evals/rewards";
import type { TasksetPackage } from "./taskset-package-contracts.js";
import type { ModelBatchReviewRequest } from "./model-batch-review-contracts.js";

/** Hosts supply the authorized package and selected Reward graph. Only this
 * new namespace becomes editable; parent sources and decisions are not copied. */
export function prepareModelBatchReview(input: {
  scope: string; request: ModelBatchReviewRequest; package: TasksetPackage; now: string;
  binding: RewardBinding; rewards: RewardRelease[]; assets: LearningTextAsset[];
}) {
  const { request, package: value } = input;
  const learning = value.learningResources;
  if (!learning) throw new LearningDomainError("model_review_batch_required", 422);
  const metadata = taskBatchPackageMetadata(value.taskset);
  const id = `model-review-${contentHash([input.scope, request.modelId, request.operationId])}`;
  const edits = new Map(request.examples.map(edit => [contentHash(edit.evidence), edit]));
  const parentRefs = new Set(learning.evidence.map(evidence => contentHash(learningRef(evidence))));
  const decisions = new Map(learning.decisions.map(decision => [contentHash(decision.evidence), decision]));
  if (edits.size !== request.examples.length || request.examples.some(edit => !parentRefs.has(contentHash(edit.evidence)))) {
    throw new LearningDomainError("model_review_evidence_mismatch", 409);
  }
  for (const resource of [input.binding, ...input.rewards, ...input.assets]) assertLearningContentHash(resource);
  resolveBoundRewards(input.binding, input.rewards);
  const rewardByHash = new Map<string, RewardRelease>();
  for (const source of input.binding.sources) {
    const original = input.rewards.find(reward => sameLearningRef(learningRef(reward), source.reward))!;
    const { contentHash: _hash, ...content } = original;
    rewardByHash.set(original.contentHash, createRewardRelease({ ...content, id: `${id}-reward-${original.contentHash}`, revision: 1 }));
  }
  const rewards = [...rewardByHash.values()];
  const { contentHash: _bindingHash, recipeRef: _recipe, ...bindingContent } = input.binding;
  const binding = createRewardBinding({ ...bindingContent, id: `${id}-binding`, revision: 1,
    sources: input.binding.sources.map(source => ({ ...source, reward: learningRef(rewardByHash.get(source.reward.contentHash)!) })),
  }, rewards);
  const assetRefs = rewards.flatMap(reward => [...reward.assets,
    ...("verifierRef" in reward.implementation ? [reward.implementation.verifierRef] : []),
    ...("rubricRef" in reward.implementation ? [reward.implementation.rubricRef] : []),
    ...("inputContract" in reward.implementation ? [reward.implementation.inputContract] : []),
  ]);
  const assets = [...new Map(assetRefs.map(ref => {
    const asset = input.assets.find(asset => asset.id === ref.id);
    if (!asset) throw new LearningDomainError("model_review_reward_asset_missing", 422);
    verifyLearningTextAsset(asset, ref);
    if (ref.visibility === "policy") throw new LearningDomainError("reward_asset_visibility_invalid", 422);
    return [asset.id, asset] as const;
  })).values()];
  // New graders invalidate the parent's verifier-set identity. Preparation of
  // the newly sealed batch will bind its own exact execution releases.
  const { environmentRelease: _environment, verifierSetRelease: _verifiers, ...execution } = metadata.definition.execution;
  const { contentHash: _definitionHash, ...definitionContent } = metadata.definition;
  const definition = TaskDefinitionSchema.parse(sealLearningContent({ ...definitionContent, ...request.definition,
    id: `${id}-definition`, revision: 1, rewardBinding: learningRef(binding), execution: { ...execution,
      policy: { ...execution.policy, hiddenGraderRefs: compileBoundGraders(binding, rewards).filter(grader => grader.privileged).map(grader => grader.id) },
    },
  }));
  const source = LearningSourceSchema.parse(sealLearningContent({
    schemaVersion: "openpond.learningSource.v1", id, revision: 1, name: `${definition.name} review`, kind: "direct",
    taskDefinition: learningRef(definition), enabled: true, allowedSplits: [...new Set(learning.evidence.map(item => item.submission.split))],
    mapping: null, adapterVersion: null, reviewOrigin: { modelId: request.modelId, packageHash: value.contentHash,
      taskset: learningRef(value.taskset), batch: learningRef(learning.batch), rewardBinding: learningRef(input.binding) },
  }));
  const evidence = learning.evidence.map(parent => {
    const edit = edits.get(contentHash(learningRef(parent)));
    // Example/attempt IDs are unique within the original source, not across
    // all sources in a batch. Preserve both parents when merging namespaces.
    const attemptId = `review-${parent.contentHash}`;
    const policyChanged = contentHash({ instructions: definition.instructions, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema,
      input: edit?.input ?? parent.submission.input }) !== contentHash({ instructions: metadata.definition.instructions,
      inputSchema: metadata.definition.inputSchema, outputSchema: metadata.definition.outputSchema, input: parent.submission.input });
    return TaskEvidenceSchema.parse(sealLearningContent({
      schemaVersion: "openpond.taskEvidence.v1", id: learningEvidenceId(source.id, parent.submission.exampleId, attemptId), revision: 1,
      source: learningRef(source), submission: { ...parent.submission, sourceId: source.id, taskDefinition: learningRef(definition),
        attemptId,
        // The old response was observed under the old policy-visible task. Its
        // parent snapshot remains available, but it is not a run of new inputs.
        observedOutput: policyChanged ? null : parent.submission.observedOutput,
        idempotencyKey: `${id}-${parent.contentHash}`, ...(edit?.input === undefined ? {} : { input: edit.input }),
        ...(edit?.expected === undefined ? {} : { expected: edit.expected }),
        ...(edit?.evaluatorContext === undefined ? {} : { evaluatorContext: edit.evaluatorContext }),
      }, supersedes: learningRef(parent), correctionFeedbackId: null, receivedAt: input.now,
    }));
  });
  const proposals = evidence.flatMap(item => {
    const edit = edits.get(contentHash(item.supersedes));
    const decision = decisions.get(contentHash(item.supersedes))!;
    const target = edit?.proposedTarget === undefined ? decision.approvedTarget : edit.proposedTarget;
    return target === null ? [] : [TaskFeedbackSchema.parse({
      schemaVersion: "openpond.taskFeedbackRecord.v1", id: `feedback-${contentHash([id, item.id])}`, revision: 1,
      submission: { schemaVersion: "openpond.taskFeedback.v1", sourceId: source.id, idempotencyKey: `${id}-${item.id}`,
        exampleId: item.submission.exampleId, attemptId: item.submission.attemptId, expectedEvidenceHash: item.contentHash,
        occurredAt: input.now, kind: "target_correction", value: target, note: "Proposed target for the revised task. Grade and review before admission." },
      status: "pending_review", evidence: learningRef(item), createdAt: input.now, review: null,
    })];
  });
  return { source, definition, binding, rewards, assets, evidence, proposals };
}
