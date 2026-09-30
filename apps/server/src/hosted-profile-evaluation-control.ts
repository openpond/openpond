import { z } from "zod";
import { OpenPondProfileRefSchema } from "@openpond/contracts";
import { assertContentHash } from "@openpond/harness";
import { ProfileEvaluationComparisonSchema, ProfileEvaluationSuiteRunSchema } from "@openpond/evals";
import { LocalProfileEvaluationRunSchema } from "./store/profile-evaluation-record.js";
import { createProfileEvaluationComparisonService } from "./harness/profile-evaluation-comparison-service.js";
import { buildProfileEvaluationReport } from "./harness/profile-evaluation-report-service.js";

const schema = z.object({ profileRef: OpenPondProfileRefSchema, sourceRevision: z.string().min(1),
  action: z.enum(["compare", "report"]), request: z.unknown(),
  runs: z.array(LocalProfileEvaluationRunSchema).max(10_000),
  comparisons: z.array(ProfileEvaluationComparisonSchema).max(10_000),
  suiteRuns: z.array(ProfileEvaluationSuiteRunSchema).max(10_000),
}).strict();

/** Host-authorized controls derive results through the native evaluator contracts. */
export async function controlHostedProfileEvaluation(raw: unknown) {
  const input = schema.parse(raw);
  for (const value of [...input.runs, ...input.comparisons, ...input.suiteRuns]) assertContentHash(value, "Hosted evaluation evidence");
  const store = {
    getProfileEvaluationRun: async (id: string) => input.runs.find(run => run.manifest.id === id) ?? null,
    getProfileEvaluationComparison: async (id: string) => input.comparisons.find(value => value.id === id) ?? null,
    getProfileEvaluationSuiteRun: async (id: string) => input.suiteRuns.find(value => value.id === id) ?? null,
    saveProfileEvaluationComparison: async (_ref: unknown, value: z.infer<typeof ProfileEvaluationComparisonSchema>) => value,
  };
  return input.action === "compare" ? createProfileEvaluationComparisonService({ store,
    selectedProfile: async () => ({ ref: input.profileRef, sourceRevision: input.sourceRevision }),
  })(input.request) : buildProfileEvaluationReport({ store, profileRef: input.profileRef, request: input.request });
}
