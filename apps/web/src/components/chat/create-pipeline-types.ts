import type { CreatePipelineRequest, CreatePipelineSnapshot } from "@openpond/contracts";

export type CreatePipelineReviewActionInput = {
  turnId: string;
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot | null;
};
