import { z } from "zod";
import { assertContentHash, contentHash, ImmutableReleaseRefSchema } from "@openpond/harness";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const AcceptanceCheckSchema = z.object({
  id: Id, name: z.string().trim().min(1).max(200), required: z.boolean(),
  role: z.enum(["quality", "retention", "diagnostic"]).optional(),
  unit: z.string().trim().min(1).max(80).optional(),
  baselineReuse: z.object({ maximumAgeSeconds: z.number().int().positive().max(31_536_000), qualification: ImmutableReleaseRefSchema }).strict().optional(),
  dataset: ImmutableReleaseRefSchema, evaluator: ImmutableReleaseRefSchema,
  executionHash: Hash, populationHash: Hash, metric: Id, direction: z.enum(["higher", "lower"]),
  minimumCoverage: z.number().positive().max(1), threshold: z.number().finite(),
  maximumRegression: z.number().finite().nonnegative(), maximumSpendUsd: z.number().finite().positive(),
}).strict().superRefine((check, ctx) => {
  if (check.role === "diagnostic" && check.required) ctx.addIssue({ code: "custom", message: "Diagnostic checks cannot be required acceptance gates." });
});
export const AcceptancePlanContentSchema = z.object({
  schemaVersion: z.literal("openpond.acceptancePlan.v1"), id: Id, revision: z.number().int().positive(),
  checks: z.array(AcceptanceCheckSchema).min(1).max(100),
  maximumSpendUsd: z.number().finite().positive(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks.map(c => c.id)).size !== value.checks.length) ctx.addIssue({ code: "custom", message: "Acceptance check IDs must be unique." });
  if (!value.checks.some(c => c.required)) ctx.addIssue({ code: "custom", message: "An acceptance plan needs at least one required check." });
  if (value.checks.reduce((total, c) => total + c.maximumSpendUsd, 0) > value.maximumSpendUsd + 1e-9) ctx.addIssue({ code: "custom", message: "Check budgets exceed the total plan budget." });
});
export const AcceptancePlanSchema = AcceptancePlanContentSchema.safeExtend({ contentHash: Hash });
export type AcceptancePlan = z.infer<typeof AcceptancePlanSchema>;
export function createAcceptancePlan(input: z.input<typeof AcceptancePlanContentSchema>): AcceptancePlan {
  const value = AcceptancePlanContentSchema.parse(input);
  return { ...value, contentHash: contentHash(value) };
}
export const AcceptanceMeasurementSchema = z.object({
  runId: Id, artifact: ImmutableReleaseRefSchema, checkHash: Hash,
  populationHash: Hash, scoredPopulationHash: Hash, executionHash: Hash, evaluator: ImmutableReleaseRefSchema,
  metric: Id, expectedCount: z.number().int().positive(), scoredCount: z.number().int().nonnegative(),
  score: z.number().finite().nullable(), status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  evidenceHash: Hash,
}).strict().superRefine((value, ctx) => {
  if (value.scoredCount > value.expectedCount) ctx.addIssue({ code: "custom", message: "Scored count exceeds declared population." });
  if ((value.scoredCount === 0) !== (value.score === null)) ctx.addIssue({ code: "custom", message: "Scores require a nonempty scored population." });
});
export type AcceptanceMeasurement = z.infer<typeof AcceptanceMeasurementSchema>;
export type AcceptanceVerdict = { passed: boolean; checks: Array<{ id: string; required: boolean; state: "passed" | "failed" | "blocked"; reasons: string[]; delta: number | null }> };

/** Evaluates verified retained measurements, never browser-supplied scores.
 * Hosts must load and verify the referenced receipts and authorize their scope. */
export function evaluateAcceptancePlan(input: {
  plan: AcceptancePlan; baseline: z.infer<typeof ImmutableReleaseRefSchema>; candidate: z.infer<typeof ImmutableReleaseRefSchema>;
  measurements: Array<{ checkId: string; baseline: AcceptanceMeasurement | null; candidate: AcceptanceMeasurement | null }>;
}): AcceptanceVerdict {
  const plan = AcceptancePlanSchema.parse(input.plan);
  assertContentHash(plan, "Acceptance plan");
  const baseline = ImmutableReleaseRefSchema.parse(input.baseline);
  const candidate = ImmutableReleaseRefSchema.parse(input.candidate);
  if (new Set(input.measurements.map(m => m.checkId)).size !== input.measurements.length || input.measurements.some(m => !plan.checks.some(c => c.id === m.checkId))) throw new Error("Acceptance evidence has duplicate or unknown checks.");
  const checks = plan.checks.map(check => {
    const pair = input.measurements.find(m => m.checkId === check.id);
    const reasons: string[] = [];
    const expectedHash = contentHash(check);
    const values = [pair?.baseline ?? null, pair?.candidate ?? null].map((raw, index) => {
      if (!raw) { reasons.push(index ? "candidate_missing" : "baseline_missing"); return null; }
      const value = AcceptanceMeasurementSchema.parse(raw);
      if (contentHash(value.artifact) !== contentHash(index ? candidate : baseline)) reasons.push("artifact_mismatch");
      if (value.checkHash !== expectedHash || value.populationHash !== check.populationHash || value.executionHash !== check.executionHash || contentHash(value.evaluator) !== contentHash(check.evaluator) || value.metric !== check.metric) reasons.push("configuration_mismatch");
      if (value.status !== "completed") reasons.push(`execution_${value.status}`);
      if (value.score === null || value.scoredCount / value.expectedCount < check.minimumCoverage) reasons.push("coverage_incomplete");
      return value;
    });
    if (values[0] && values[1] && (values[0].expectedCount !== values[1].expectedCount || values[0].scoredCount !== values[1].scoredCount || values[0].scoredPopulationHash !== values[1].scoredPopulationHash)) reasons.push("population_count_mismatch");
    if (reasons.length) return { id: check.id, required: check.required, state: "blocked" as const, reasons: [...new Set(reasons)], delta: null };
    const before = values[0]!.score!;
    const after = values[1]!.score!;
    const delta = (after - before) * (check.direction === "higher" ? 1 : -1);
    if (check.direction === "higher" ? after < check.threshold : after > check.threshold) reasons.push("threshold_failed");
    if (delta < -check.maximumRegression) reasons.push("regression_failed");
    return { id: check.id, required: check.required, state: reasons.length ? "failed" as const : "passed" as const, reasons, delta };
  });
  return { passed: checks.filter(c => c.required).every(c => c.state === "passed"), checks };
}
