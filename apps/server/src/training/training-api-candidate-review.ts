import { z } from "zod";
import type { createManagedCandidateReviewService } from "./managed-candidate-review.js";

type Action = "managed_candidate_review" | "record_managed_candidate_review" | "managed_candidate_review_history";
export function isManagedCandidateReviewAction(action: string): action is Action {
  return action === "managed_candidate_review" || action === "record_managed_candidate_review" || action === "managed_candidate_review_history";
}
export async function handleManagedCandidateReviewAction(action: Action, input: Record<string, unknown>, service: ReturnType<typeof createManagedCandidateReviewService>) {
  const modelId = z.string().trim().min(1).max(191).parse(input.modelId);
  if (action === "record_managed_candidate_review") return service.record(modelId, input.review);
  if (action === "managed_candidate_review_history") return service.history(modelId, {
    id: z.string().trim().min(1).max(500).parse(input.decisionId),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).parse(input.decisionHash),
  });
  return service.read(modelId, input.refresh === true);
}
