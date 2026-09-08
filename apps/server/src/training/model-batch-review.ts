import { inspectModelBatchPackage, ModelBatchReviewRequestSchema } from "openpond-sdk/taskset-packages";
import type { SqliteStore } from "../store/store.js";
import { exportLocalModelTasksetPackage } from "./model-taskset-package-export.js";

export async function inspectLocalModelBatchReview(input: { store: SqliteStore; storeDir: string; profileId: string; modelId: string }) {
  return inspectModelBatchPackage(await exportLocalModelTasksetPackage(input));
}

/** Capture the selected immutable package before entering the Model transaction. */
export async function beginLocalModelBatchReview(input: { store: SqliteStore; storeDir: string; profileId: string; request: unknown }) {
  const request = ModelBatchReviewRequestSchema.parse(input.request);
  const previous = await input.store.findModelBatchReview(input.profileId, request);
  if (previous) return previous;
  const value = await exportLocalModelTasksetPackage({ ...input, modelId: request.modelId, tasksetRef: request.tasksetRef });
  return input.store.beginModelBatchReview(input.profileId, request, value);
}
