import { z } from "zod";

import { ContinualBenchPanelRoleSchema } from "./continual-support.js";
import { ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, VersionedReleaseRefSchema } from "./release-core.js";

export const ModelCurrencyEvidenceStateSchema = z.enum(["measuring", "up_to_date", "needs_attention"]);
export const ModelCurrencyTaskClassificationSchema = z.enum(["fixed", "retained", "regressed", "unresolved", "unavailable"]);
export const ModelCurrencyAttemptEvidenceRefSchema = z.object({
  evaluationRunId: ReleaseIdSchema,
  attemptKey: ReleaseIdSchema,
  artifactPath: z.string().trim().min(1).max(2_000),
  jsonPointer: z.string().trim().min(1).max(1_000),
  transcriptHash: ReleaseHashSchema.nullable(),
  traceHash: ReleaseHashSchema.nullable(),
}).strict();
const Interval = z.object({ level: z.literal(0.95), lower: z.number().finite(), upper: z.number().finite() }).strict();
export const ModelCurrencyPanelMetricSchema = z.object({
  panelId: ReleaseIdSchema,
  panelRole: ContinualBenchPanelRoleSchema,
  passLabel: ReleaseIdSchema.nullable(),
  taskset: VersionedReleaseRefSchema,
  attempted: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  strictSuccess: z.number().min(0).max(1).nullable(),
  strictSuccessCi95: Interval.nullable(),
  judgeScore: z.number().min(0).max(100).nullable(),
  judgeScoreCi95: Interval.nullable(),
}).strict();
export const ModelCurrencySnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.modelCurrencySnapshot.v1"),
  id: ReleaseIdSchema,
  contentHash: ReleaseHashSchema,
  seriesId: ReleaseIdSchema,
  protocol: z.object({ id: ReleaseIdSchema, revision: z.number().int().positive(), contentHash: ReleaseHashSchema }).strict(),
  entryId: ReleaseIdSchema,
  passLabel: ReleaseIdSchema,
  parent: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("base_model"), id: ReleaseIdSchema, revision: z.string().trim().min(1).max(500) }).strict(),
    z.object({ kind: z.literal("model_version"), id: ReleaseIdSchema, contentHash: ReleaseHashSchema }).strict(),
  ]),
  candidate: z.object({ kind: z.literal("model_version"), id: ReleaseIdSchema, contentHash: ReleaseHashSchema }).strict(),
  sources: z.object({
    evaluationRunIds: z.array(ReleaseIdSchema).max(100_000),
    attemptIds: z.array(ReleaseIdSchema).max(1_000_000),
    tasksets: z.array(VersionedReleaseRefSchema).max(10_000),
    grader: ImmutableReleaseRefSchema,
    judge: ImmutableReleaseRefSchema.nullable(),
    calibration: ImmutableReleaseRefSchema.nullable(),
  }).strict(),
  matches: z.array(z.object({
    key: ReleaseIdSchema,
    panelId: ReleaseIdSchema,
    panelRole: ContinualBenchPanelRoleSchema,
    taskId: ReleaseIdSchema,
    issueFamilyId: ReleaseIdSchema,
    seed: z.number().int(),
    repetition: z.number().int().nonnegative(),
    classification: ModelCurrencyTaskClassificationSchema,
    parentPassed: z.boolean().nullable(),
    candidatePassed: z.boolean().nullable(),
    parentAttempt: ModelCurrencyAttemptEvidenceRefSchema.nullable(),
    candidateAttempt: ModelCurrencyAttemptEvidenceRefSchema.nullable(),
  }).strict()).max(1_000_000),
  taskIds: z.object({
    fixed: z.array(ReleaseIdSchema).max(1_000_000),
    retained: z.array(ReleaseIdSchema).max(1_000_000),
    regressed: z.array(ReleaseIdSchema).max(1_000_000),
    unresolved: z.array(ReleaseIdSchema).max(1_000_000),
    unavailable: z.array(ReleaseIdSchema).max(1_000_000),
  }).strict(),
  panels: z.array(ModelCurrencyPanelMetricSchema).max(10_000),
  metrics: z.object({
    knownIssueCoverage: z.number().min(0).max(1).nullable(),
    issueFamilyGeneralization: z.number().min(0).max(1).nullable(),
    behavioralRetention: z.number().min(0).max(1).nullable(),
    currentAcquisitionDelta: z.number().finite().nullable(),
    retainedDeltaPoints: z.number().finite().nullable(),
    frontierStrictDelta: z.number().finite().nullable(),
    pairedPValue: z.number().min(0).max(1).nullable(),
    wins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
  }).strict(),
  statistics: z.object({
    matchedAttemptCount: z.number().int().nonnegative(),
    strictDelta: z.number().finite().nullable(),
    strictDeltaCi95: Interval.nullable(),
    exactPairedBinaryPValue: z.number().min(0).max(1).nullable(),
    pairedBootstrapSamples: z.number().int().positive(),
  }).strict(),
  criteria: z.object({
    allRequiredAttemptsTerminal: z.boolean(),
    criticalCorrectionPassRate: z.number().min(0).max(1).nullable(),
    siblingPassRate: z.number().min(0).max(1).nullable(),
    behavioralRetentionRate: z.number().min(0).max(1).nullable(),
    retainedRegressionPoints: z.number().finite().nullable(),
    criticalPriorRegressionCount: z.number().int().nonnegative(),
    thresholdRelease: ImmutableReleaseRefSchema,
  }).strict(),
  efficiency: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    latencyMs: z.number().int().nonnegative(),
    tokensPerSuccess: z.number().nonnegative().nullable(),
    throughputPerHour: z.number().nonnegative().nullable(),
    gpuSeconds: z.number().nonnegative().nullable(),
  }).strict(),
  invariants: z.object({
    systemPromptHash: ReleaseHashSchema,
    toolSchema: ImmutableReleaseRefSchema,
    application: ImmutableReleaseRefSchema,
    harness: ImmutableReleaseRefSchema,
    runtime: ImmutableReleaseRefSchema,
    grader: ImmutableReleaseRefSchema,
    autoRefinerEnabled: z.boolean(),
  }).strict(),
  evidenceState: ModelCurrencyEvidenceStateSchema,
  evidenceReasons: z.array(ReleaseIdSchema).max(100),
  projectedAt: ReleaseTimestampSchema,
}).strict();

export type ModelCurrencyEvidenceState = z.infer<typeof ModelCurrencyEvidenceStateSchema>;
export type ModelCurrencyTaskClassification = z.infer<typeof ModelCurrencyTaskClassificationSchema>;
export type ModelCurrencyAttemptEvidenceRef = z.infer<typeof ModelCurrencyAttemptEvidenceRefSchema>;
export type ModelCurrencyPanelMetric = z.infer<typeof ModelCurrencyPanelMetricSchema>;
export type ModelCurrencySnapshot = z.infer<typeof ModelCurrencySnapshotSchema>;
