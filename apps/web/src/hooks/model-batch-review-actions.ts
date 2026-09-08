import { ModelBatchReviewReceiptSchema, validateTasksetPackage, type ModelBatchReviewRequest } from "openpond-sdk/taskset-packages";
import { api, type ClientConnection } from "../api";

export function modelBatchReviewActions(connection: ClientConnection | null, profileId: string, save: (request: ModelBatchReviewRequest) => Promise<unknown>) {
  return {
    inspectModelBatch: async (modelId: string) => {
      if (!connection) throw new Error("Connect to OpenPond to inspect this batch.");
      return validateTasksetPackage(await api.trainingRequest(connection, `/models/${encodeURIComponent(modelId)}/taskset-package/export`, { profileId }, "POST"));
    },
    beginModelBatchReview: async (request: ModelBatchReviewRequest) => {
      const result = await save(request);
      return result ? ModelBatchReviewReceiptSchema.parse(result) : null;
    },
  };
}
