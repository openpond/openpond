import { ModelBatchReviewInspectionSchema, ModelBatchReviewReceiptSchema, type ModelBatchReviewRequest } from "openpond-sdk/model-batch-review";
import { api, type ClientConnection } from "../api";

export function modelBatchReviewActions(connection: ClientConnection | null, profileId: string, save: (request: ModelBatchReviewRequest) => Promise<unknown>) {
  return {
    inspectModelBatch: async (modelId: string) => {
      if (!connection) throw new Error("Connect to OpenPond to inspect this batch.");
      return ModelBatchReviewInspectionSchema.parse(await api.trainingRequest(connection, "/models/batch-review/inspect", { profileId, modelId }, "POST"));
    },
    beginModelBatchReview: async (request: ModelBatchReviewRequest) => {
      const result = await save(request);
      return result ? ModelBatchReviewReceiptSchema.parse(result) : null;
    },
  };
}
