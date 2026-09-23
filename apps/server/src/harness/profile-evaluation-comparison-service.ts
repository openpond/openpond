import { z } from "zod";
import { contentHash, ReleaseIdSchema } from "@openpond/harness";
import { type OpenPondProfileRef } from "@openpond/contracts";
import { createProfileEvaluationComparison } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";

const ComparisonRequestSchema = z.object({
  id: ReleaseIdSchema,
  runIds: z.array(ReleaseIdSchema).min(2).max(100),
}).strict();

/** Retain a comparison over already graded runs in one authorized Profile.
 * Evals verifies compatible populations and explicit source/model axes. */
export function createProfileEvaluationComparisonService(input: {
  store: SqliteStore;
  selectedProfile: () => Promise<{ ref: OpenPondProfileRef; sourceRevision: string } | null>;
}) {
  return async (request: unknown) => {
    const parsed = ComparisonRequestSchema.parse(request);
    const selected = await input.selectedProfile();
    if (!selected) throw new Error("Select a Profile before comparing its evaluation runs.");
    const members = [];
    for (const runId of parsed.runIds) {
      const run = await input.store.getProfileEvaluationRun(runId);
      if (!run || contentHash(run.profileRef) !== contentHash(selected.ref)) {
        throw new Error(`Profile evaluation run ${runId} is unavailable in the selected Profile.`);
      }
      members.push({ manifest: run.manifest, result: run.metric });
    }
    const existing = await input.store.getProfileEvaluationComparison(parsed.id);
    const comparison = createProfileEvaluationComparison({
      id: parsed.id, members, createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    return input.store.saveProfileEvaluationComparison(selected.ref, comparison);
  };
}
