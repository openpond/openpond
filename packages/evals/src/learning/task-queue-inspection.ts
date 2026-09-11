import { ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";
import { z } from "zod";

import { LearningDomainError } from "./errors.js";
import { inspectIterationEligibility } from "./iteration-eligibility.js";
import { taskFamilyReservations } from "./admission.js";
import { requireLearningRelease, type LearningTransaction } from "./repository.js";

export const LearningTaskQueueInspectionSchema = z.object({
  modelProjectId: ReleaseIdSchema.nullable(),
  inspectedAt: ReleaseTimestampSchema,
  pendingTrainingCount: z.number().int().nonnegative().nullable(),
  issues: z.array(z.object({ policyId: ReleaseIdSchema, code: z.string(), message: z.string() }).strict()),
}).strict();

/** Count exact eligible, unconsumed attempts once across selected policies.
 * Paused policies still have pending work; review-only and held-out tasks do not. */
export async function inspectLearningTaskQueue(transaction: LearningTransaction, modelProjectId: string | null, now: string) {
  const eligible = new Set<string>();
  const issues: z.infer<typeof LearningTaskQueueInspectionSchema>["issues"] = [];
  let afterId: string | undefined;
  do {
    const page = await transaction.list("policy", { limit: 100, ...(modelProjectId ? { parentId: modelProjectId } : {}), ...(afterId ? { afterId } : {}) });
    for (const policy of page.items) {
      try {
        const inspection = await inspectIterationEligibility(transaction, policy, { collectEligible: true });
        const definition = await requireLearningRelease(transaction, "definition", policy.taskDefinition);
        for (const reference of inspection.eligibleEvidence) {
          const evidence = await requireLearningRelease(transaction, "evidence", reference);
          let heldOut = false;
          for (const family of taskFamilyReservations(evidence, definition)) {
            const split = await transaction.familySplit(family.namespace, family.kind, family.key);
            if (split !== null && split !== "train") { heldOut = true; break; }
          }
          if (!heldOut) eligible.add(JSON.stringify([reference.id, reference.revision, reference.contentHash]));
        }
      } catch (error) {
        if (!(error instanceof LearningDomainError)) throw error;
        issues.push({ policyId: policy.id, code: error.code, message: error.message });
      }
    }
    afterId = page.nextCursor ?? undefined;
  } while (afterId);
  return LearningTaskQueueInspectionSchema.parse({ modelProjectId, inspectedAt: now, pendingTrainingCount: issues.length ? null : eligible.size, issues });
}
