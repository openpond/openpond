import { contentHash } from "@openpond/harness";
import { LearningDomainError, learningRef, sameLearningRef, requireLearningRelease, requireLearningResource, taskBatchPackageMetadata,
  type LearningResourcePointer, type LearningTransaction } from "@openpond/evals/learning";
import { validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { ModelBatchReviewReceiptSchema, ModelBatchReviewRequestSchema, type ModelBatchReviewRequest } from "./model-batch-review-contracts.js";
import { prepareModelBatchReview } from "./model-batch-review-preparation.js";

export * from "./model-batch-review-contracts.js";
export { LearningDomainError as ModelBatchReviewError } from "@openpond/evals/learning";

const operation = (request: ModelBatchReviewRequest) => `model-batch-review-${contentHash([request.modelId, request.operationId])}`;

export async function findModelBatchReview(transaction: LearningTransaction, raw: ModelBatchReviewRequest) {
  const request = ModelBatchReviewRequestSchema.parse(raw);
  const prior = await transaction.operation(operation(request));
  if (!prior) return null;
  if (prior.requestHash !== contentHash(request)) throw new LearningDomainError("learning_idempotency_conflict", 409);
  return readReceipt(transaction, request, prior.resources);
}

/** Run inside the host's scope/Model revision transaction after verifying the
 * selected source package. This publishes new editable evidence, never a Model
 * attachment, admission, source credential, grade, or training job. */
export async function beginModelBatchReview(transaction: LearningTransaction, input: {
  scope: string; request: ModelBatchReviewRequest; package: TasksetPackage; now: string;
}) {
  const request = ModelBatchReviewRequestSchema.parse(input.request);
  const prior = await findModelBatchReview(transaction, request);
  if (prior) return prior;
  const value = validateTasksetPackage(input.package);
  if (!value.learningResources) throw new LearningDomainError("model_review_batch_required", 422);
  const metadata = taskBatchPackageMetadata(value.taskset);
  const selected = request.rewardBindingRef;
  const retained = !selected || sameLearningRef(selected, learningRef(metadata.binding));
  const binding = retained ? metadata.binding : await requireLearningRelease(transaction, "binding", selected);
  const rewards = retained ? metadata.rewards : await Promise.all(binding.sources.map(source => requireLearningRelease(transaction, "reward", source.reward)));
  const assetIds = new Set(rewards.flatMap(reward => [...reward.assets,
    ...("verifierRef" in reward.implementation ? [reward.implementation.verifierRef] : []),
    ...("rubricRef" in reward.implementation ? [reward.implementation.rubricRef] : []),
    ...("inputContract" in reward.implementation ? [reward.implementation.inputContract] : []),
  ]).map(asset => asset.id));
  const assets = retained ? value.learningResources.assets : await Promise.all([...assetIds].map(id => requireLearningResource(transaction, "asset", id, 1)));
  const prepared = prepareModelBatchReview({ ...input, request, package: value, binding, rewards, assets });
  const pointers: LearningResourcePointer[] = [];
  for (const asset of prepared.assets) {
    const existing = await transaction.get("asset", asset.id, 1);
    if (existing && existing.contentHash !== asset.contentHash) throw new LearningDomainError("model_review_asset_conflict", 409);
    if (!existing) await transaction.put("asset", asset, 0);
  }
  for (const reward of prepared.rewards) await transaction.put("reward", reward, 0);
  await transaction.put("binding", prepared.binding, 0);
  await transaction.put("definition", prepared.definition, 0);
  await transaction.put("source", prepared.source, 0, { parentId: request.modelId });
  pointers.push({ kind: "source", id: prepared.source.id, revision: 1 });
  for (const evidence of prepared.evidence) {
    await transaction.put("evidence", evidence, 0, { parentId: prepared.source.id });
    pointers.push({ kind: "evidence", id: evidence.id, revision: 1 });
  }
  for (const proposal of prepared.proposals) {
    await transaction.put("feedback", proposal, 0, { parentId: proposal.evidence!.id, status: proposal.status });
    pointers.push({ kind: "feedback", id: proposal.id, revision: 1 });
  }
  await transaction.saveOperation(operation(request), { requestHash: contentHash(request), resources: pointers });
  return readReceipt(transaction, request, pointers);
}

async function readReceipt(transaction: LearningTransaction, request: ModelBatchReviewRequest, pointers: LearningResourcePointer[]) {
  const resources = await Promise.all(pointers.map(pointer => requireLearningResource(transaction, pointer.kind, pointer.id, pointer.revision)));
  return ModelBatchReviewReceiptSchema.parse({ schemaVersion: "openpond.modelBatchReviewReceipt.v1", operationId: request.operationId,
    modelId: request.modelId, source: resources.find(resource => resource.schemaVersion === "openpond.learningSource.v1"),
    evidence: resources.filter(resource => resource.schemaVersion === "openpond.taskEvidence.v1"),
    proposals: resources.filter(resource => resource.schemaVersion === "openpond.taskFeedbackRecord.v1"),
  });
}
