import { canonicalSha256, canonicalJson, OpenPondProtocolError } from "./protocol.js";
import { DatasetTrainingReviewRequestSchema, DatasetTrainingReviewReceiptSchema,
  type DatasetTrainingReviewRequest } from "./dataset-training-review-contracts.js";

export * from "./dataset-training-review-contracts.js";

export async function parseAndVerifyDatasetTrainingReviewReceipt(raw: unknown, input: DatasetTrainingReviewRequest, actorId?: string) {
  const request = DatasetTrainingReviewRequestSchema.parse(input);
  const value = DatasetTrainingReviewReceiptSchema.parse(raw);
  const { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content) || value.requestHash !== await canonicalSha256(request)
    || value.id !== `dataset-review-${await canonicalSha256([value.teamId, value.actorId, value.operationId])}`
    || value.teamId !== request.teamId || actorId && value.actorId !== actorId
    || value.operationId !== request.operationId || value.packageHash !== request.packageHash
    || canonicalJson(value.dataset) !== canonicalJson(request.dataset) || value.purpose !== request.purpose)
    throw new OpenPondProtocolError("dataset_training_review_mismatch", "The Dataset review receipt differs from its exact source or operation.");
  if (new Set(value.evidence.map(ref => ref.id)).size !== value.evidence.length
    || new Set(value.proposals.map(ref => ref.id)).size !== value.proposals.length
    || value.proposals.length > value.evidence.length
    || request.taskIds && value.evidence.length !== request.taskIds.length)
    throw new OpenPondProtocolError("dataset_training_review_inventory_mismatch", "The Dataset review returned another example inventory.");
  return value;
}

export function createDatasetTrainingReviewClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async reviewDataset(input: DatasetTrainingReviewRequest) {
      const parsed = DatasetTrainingReviewRequestSchema.parse(input);
      return parseAndVerifyDatasetTrainingReviewReceipt(await request("/v1/training/dataset-reviews", {
        method: "POST", body: canonicalJson(parsed),
      }), parsed);
    },
  };
}
