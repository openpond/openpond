import { z } from "zod";
import {
  ImmutableArtifactRefSchema,
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  assertContentHash,
  contentHash,
} from "@openpond/harness";
import { ProfileEvaluationRunSourceSchema } from "./profile-evaluations.js";
import { FeedbackKeySchema } from "./rewards.js";

const MoneySchema = z.number().finite().nonnegative();

export const ExperimentTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model"),
    modelId: ReleaseIdSchema,
    configurationHash: ReleaseHashSchema,
  }).strict(),
  z.object({
    kind: z.literal("harness"),
    source: ProfileEvaluationRunSourceSchema,
  }).strict(),
  z.object({ kind: z.literal("fixture"), configurationHash: ReleaseHashSchema }).strict(),
]);

export const ExperimentEvaluatorSchema = z.object({
  // A reusable Reward has a numeric revision; a dataset-authored GraderSpec
  // has its exact version string and implementation hash. Neither is invented.
  release: ImmutableReleaseRefSchema.extend({ revision: z.union([z.number().int().positive(), z.string().trim().min(1).max(200)]) }).strict(),
  feedbackKey: FeedbackKeySchema,
  /** Binds field mappings and admitted scorer settings without changing the Reward's release hash. */
  configurationHash: ReleaseHashSchema.optional(),
  output: z.enum(["boolean", "score", "category"]),
  /** Category labels are meaningful only for category output. */
  categories: z.array(z.string().trim().min(1).max(120)).max(50),
}).strict().superRefine((value, context) => {
  if ((value.output === "category") !== (value.categories.length > 0))
    context.addIssue({ code: "custom", path: ["categories"], message: "Only category feedback declares categories." });
  if (new Set(value.categories).size !== value.categories.length)
    context.addIssue({ code: "custom", path: ["categories"], message: "Feedback categories must be unique." });
});

export const ExperimentCaseIdentitySchema = z.object({
  caseId: ReleaseIdSchema,
  seed: z.string().trim().min(1).max(500),
  fixtureId: ReleaseIdSchema.nullable(),
}).strict();
export type ExperimentCaseIdentity = z.infer<typeof ExperimentCaseIdentitySchema>;
export function experimentCaseKey(identity: ExperimentCaseIdentity): string {
  const value = ExperimentCaseIdentitySchema.parse(identity);
  return JSON.stringify([value.caseId, value.seed, value.fixtureId]);
}

export const ExperimentManifestContentSchema = z.object({
  schemaVersion: z.literal("openpond.experimentManifest.v1"),
  id: ReleaseIdSchema,
  name: z.string().trim().min(1).max(500),
  teamId: ReleaseIdSchema,
  operationId: ReleaseIdSchema,
  /** Historical imported runs may have no admitted whole-run ceiling. */
  maximumCostUsd: MoneySchema.nullable(),
  dataset: ImmutableReleaseRefSchema.extend({ revision: z.number().int().positive() }).strict(),
  target: ExperimentTargetSchema,
  execution: z.object({ packageHash: ReleaseHashSchema, runtimeTargetHash: ReleaseHashSchema, metricPolicyHash: ReleaseHashSchema }).strict().optional(),
  lineage: z.object({
    definition: ImmutableReleaseRefSchema.extend({ revision: z.number().int().positive() }).strict().nullable(),
    execution: ImmutableReleaseRefSchema,
    scoringPassId: ReleaseIdSchema.nullable(),
  }).strict().optional(),
  evaluators: z.array(ExperimentEvaluatorSchema).max(100),
  population: z.array(ExperimentCaseIdentitySchema).min(1).max(10_000),
  createdAt: ReleaseTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.lineage && value.id !== (value.lineage.scoringPassId ?? value.lineage.execution.id))
    context.addIssue({ code: "custom", path: ["lineage"], message: "Experiment identity must match its execution or independent scoring pass." });
  if (new Set(value.population.map(experimentCaseKey)).size !== value.population.length)
    context.addIssue({ code: "custom", path: ["population"], message: "Experiment cases must be unique." });
  if (new Set(value.evaluators.map((item) => item.feedbackKey)).size !== value.evaluators.length)
    context.addIssue({ code: "custom", path: ["evaluators"], message: "Experiment feedback keys must be unique." });
});
export const ExperimentManifestSchema = ExperimentManifestContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;

export const ExperimentFeedbackSchema = z.object({
  feedbackKey: FeedbackKeySchema,
  evaluator: ExperimentEvaluatorSchema.shape.release,
  status: z.enum(["scored", "unavailable", "failed", "pending"]),
  value: z.union([z.boolean(), z.number().finite(), z.string().max(120)]).nullable(),
  passed: z.boolean().nullable().optional(),
  reasoning: z.string().max(20_000).nullable(),
  evidenceRefs: z.array(ImmutableArtifactRefSchema).max(1_000),
}).strict();

export const ExperimentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  costUsd: MoneySchema.nullable(),
  latencyMs: z.number().finite().nonnegative().nullable(),
}).strict().superRefine((usage, context) => {
  if (usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null
    && usage.totalTokens < usage.inputTokens + usage.outputTokens)
    context.addIssue({ code: "custom", path: ["totalTokens"], message: "Total tokens cannot be less than input plus output." });
});

export const ExperimentCaseResultSchema = z.object({
  identity: ExperimentCaseIdentitySchema,
  status: z.enum(["completed", "failed", "cancelled", "unavailable"]),
  output: z.unknown().nullable(),
  error: z.object({ code: ReleaseIdSchema, message: z.string().max(2_000) }).strict().nullable(),
  feedback: z.array(ExperimentFeedbackSchema).max(100),
  usage: ExperimentUsageSchema,
  traceRef: ImmutableArtifactRefSchema.nullable(),
  startedAt: ReleaseTimestampSchema.nullable(),
  completedAt: ReleaseTimestampSchema.nullable(),
}).strict();

export const ExperimentResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.experimentResult.v1"),
  manifest: ImmutableReleaseRefSchema,
  status: z.enum(["completed", "failed", "cancelled"]),
  cases: z.array(ExperimentCaseResultSchema).min(1).max(10_000),
  completedAt: ReleaseTimestampSchema,
}).strict();
export const ExperimentResultSchema = ExperimentResultContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();
export type ExperimentResult = z.infer<typeof ExperimentResultSchema>;

export function createExperimentManifest(input: z.input<typeof ExperimentManifestContentSchema>): ExperimentManifest {
  const value = ExperimentManifestContentSchema.parse(input);
  return ExperimentManifestSchema.parse({ ...value, contentHash: contentHash(value) });
}

export function createExperimentResult(input: z.input<typeof ExperimentResultContentSchema>, manifest: ExperimentManifest): ExperimentResult {
  ExperimentManifestSchema.parse(manifest);
  assertContentHash(manifest, "Experiment manifest");
  const value = ExperimentResultContentSchema.parse(input);
  if (value.manifest.id !== manifest.id || value.manifest.contentHash !== manifest.contentHash)
    throw new Error("Experiment result differs from its manifest.");
  const expected = new Set(manifest.population.map(experimentCaseKey));
  const seen = new Set<string>();
  const evaluators = new Map(manifest.evaluators.map((item) => [item.feedbackKey, item]));
  for (const result of value.cases) {
    const key = experimentCaseKey(result.identity);
    if (!expected.has(key) || seen.has(key)) throw new Error("Experiment result has an unexpected or repeated case.");
    seen.add(key);
    const feedbackKeys = new Set<string>();
    for (const feedback of result.feedback) {
      const evaluator = evaluators.get(feedback.feedbackKey);
      if (!evaluator || feedbackKeys.has(feedback.feedbackKey)
        || feedback.evaluator.id !== evaluator.release.id
        || feedback.evaluator.contentHash !== evaluator.release.contentHash
        || feedback.evaluator.revision !== evaluator.release.revision)
        throw new Error("Experiment feedback differs from its pinned evaluator.");
      feedbackKeys.add(feedback.feedbackKey);
      if (feedback.status === "scored") {
        if (feedback.value === null || typeof feedback.value !== ({ boolean: "boolean", score: "number", category: "string" } as const)[evaluator.output]
          || (evaluator.output === "category" && !evaluator.categories.includes(feedback.value as string))
          || (evaluator.output === "score" && (feedback.value as number < 0 || feedback.value as number > 1)))
          throw new Error("Experiment feedback value violates its output contract.");
      } else if (feedback.value !== null || feedback.passed !== null && feedback.passed !== undefined) throw new Error("Unscored experiment feedback cannot claim a value or pass decision.");
    }
  }
  if (seen.size !== expected.size) throw new Error("Experiment result omits admitted cases.");
  return ExperimentResultSchema.parse({ ...value, contentHash: contentHash(value) });
}

export type ExperimentComparison = {
  comparable: boolean;
  reasons: string[];
  cases: Array<{ identity: ExperimentCaseIdentity; baseline: ExperimentCaseResult | null; candidate: ExperimentCaseResult | null;
    feedback: ExperimentFeedbackComparison[] }>;
  metrics: ExperimentComparisonMetric[];
};
export type ExperimentCaseResult = z.infer<typeof ExperimentCaseResultSchema>;
export type ExperimentFeedbackComparison = {
  feedbackKey: string;
  eligible: boolean;
  reason: "incompatible_experiments" | "missing_case" | "case_not_completed" | "feedback_unavailable" | "categorical_feedback" | null;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  baselinePassed: boolean | null;
  candidatePassed: boolean | null;
};
export type ExperimentComparisonMetric = {
  feedbackKey: string;
  eligibleCount: number;
  excludedCount: number;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  baselinePassRate: number | null;
  candidatePassRate: number | null;
  passRateDelta: number | null;
};

export function verifyExperimentEvidence(input: { manifest: unknown; result: unknown }) {
  const manifest = ExperimentManifestSchema.parse(input.manifest);
  const result = ExperimentResultSchema.parse(input.result);
  const { contentHash: hash, ...content } = result;
  if (contentHash(content) !== hash) throw new Error("Experiment result integrity failed.");
  createExperimentResult(content, manifest);
  return { manifest, result };
}

/** A comparison reads retained results; it never executes or regrades a case. */
export function compareExperiments(
  baseline: { manifest: ExperimentManifest; result: ExperimentResult },
  candidate: { manifest: ExperimentManifest; result: ExperimentResult },
): ExperimentComparison {
  for (const pair of [baseline, candidate]) {
    verifyExperimentEvidence(pair);
  }
  const reasons: string[] = [];
  if (baseline.manifest.teamId !== candidate.manifest.teamId) reasons.push("different_workspace");
  if (baseline.manifest.dataset.id !== candidate.manifest.dataset.id
    || baseline.manifest.dataset.contentHash !== candidate.manifest.dataset.contentHash
    || baseline.manifest.dataset.revision !== candidate.manifest.dataset.revision) reasons.push("different_dataset_version");
  if (baseline.manifest.target.kind !== candidate.manifest.target.kind) reasons.push("different_target_kind");
  if (contentHash(baseline.manifest.execution ?? null) !== contentHash(candidate.manifest.execution ?? null)) reasons.push("different_execution_contract");
  if (baseline.manifest.target.kind === "harness" && candidate.manifest.target.kind === "harness") {
    const a = baseline.manifest.target.source; const b = candidate.manifest.target.source;
    if (a.profileId !== b.profileId || contentHash(a.target) !== contentHash(b.target)) reasons.push("different_component");
    if (a.environmentHash !== b.environmentHash) reasons.push("different_environment");
    if (a.definitionId !== b.definitionId || a.definitionHash !== b.definitionHash) reasons.push("different_evaluation_definition");
  }
  const orderedEvaluators = (manifest: ExperimentManifest) => [...manifest.evaluators].sort((a, b) => a.feedbackKey.localeCompare(b.feedbackKey));
  if (contentHash(orderedEvaluators(baseline.manifest)) !== contentHash(orderedEvaluators(candidate.manifest))) reasons.push("different_evaluators");
  const left = new Map(baseline.result.cases.map((item) => [experimentCaseKey(item.identity), item]));
  const right = new Map(candidate.result.cases.map((item) => [experimentCaseKey(item.identity), item]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  if (left.size !== right.size || keys.some((key) => !left.has(key) || !right.has(key))) reasons.push("different_population");
  const comparable = reasons.length === 0;
  const cases = keys.map((key) => {
    const baselineCase = left.get(key) ?? null;
    const candidateCase = right.get(key) ?? null;
    const baselineFeedback = new Map(baselineCase?.feedback.map(item => [item.feedbackKey, item]) ?? []);
    const candidateFeedback = new Map(candidateCase?.feedback.map(item => [item.feedbackKey, item]) ?? []);
    return {
      identity: (baselineCase ?? candidateCase)!.identity,
      baseline: baselineCase,
      candidate: candidateCase,
      feedback: baseline.manifest.evaluators.map(evaluator => {
        const a = baselineFeedback.get(evaluator.feedbackKey);
        const b = candidateFeedback.get(evaluator.feedbackKey);
        const reason: ExperimentFeedbackComparison["reason"] = !comparable ? "incompatible_experiments"
          : !baselineCase || !candidateCase ? "missing_case"
          : baselineCase.status !== "completed" || candidateCase.status !== "completed" || baselineCase.error || candidateCase.error ? "case_not_completed"
          : !a || !b || a.status !== "scored" || b.status !== "scored" ? "feedback_unavailable"
          : evaluator.output === "category" ? "categorical_feedback" : null;
        const numeric = (item: typeof a) => typeof item?.value === "boolean" ? Number(item.value)
          : typeof item?.value === "number" ? item.value : null;
        const av = reason ? null : numeric(a);
        const bv = reason ? null : numeric(b);
        const pass = (item: typeof a) => reason ? null : typeof item?.value === "boolean" ? item.value : item?.passed ?? null;
        return { feedbackKey: evaluator.feedbackKey, eligible: reason === null, reason,
          baseline: av, candidate: bv, delta: av === null || bv === null ? null : bv - av,
          baselinePassed: pass(a), candidatePassed: pass(b) };
      }),
    };
  });
  const metrics = baseline.manifest.evaluators.map((evaluator, index) => {
    const eligible = cases.map(item => item.feedback[index]!).filter(value => value.eligible);
    const mean = (field: "baseline" | "candidate") => eligible.length
      ? eligible.reduce((sum, value) => sum + value[field]!, 0) / eligible.length : null;
    const a = mean("baseline"); const b = mean("candidate");
    const passRate = (field: "baselinePassed" | "candidatePassed") => eligible.length && eligible.every(value => value[field] !== null)
      ? eligible.reduce((sum, value) => sum + Number(value[field]), 0) / eligible.length : null;
    const ap = passRate("baselinePassed"); const bp = passRate("candidatePassed");
    return { feedbackKey: evaluator.feedbackKey, eligibleCount: eligible.length, excludedCount: cases.length - eligible.length,
      baseline: a, candidate: b, delta: a === null || b === null ? null : b - a,
      baselinePassRate: ap, candidatePassRate: bp, passRateDelta: ap === null || bp === null ? null : bp - ap };
  });
  return {
    comparable,
    reasons,
    cases,
    metrics,
  };
}
