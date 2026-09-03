import { z } from "zod";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().datetime({ offset: true });
const ImmutableRef = z.object({ id: Id, contentHash: Hash }).strict();
const VersionedRef = ImmutableRef.extend({ revision: z.number().int().positive() }).strict();
const ChatModelRef = z.object({ providerId: Id, modelId: z.string().trim().min(1).max(300) }).strict();

export const ContinualBenchPanelRoleSchema = z.enum(["correction", "sibling_verification", "cumulative_known", "development", "retained", "frozen_final", "training_eligible"]);
export const ContinualBenchIssueCaseSchema = z.object({
  taskId: Id, taskContentHash: Hash, panelRole: ContinualBenchPanelRoleSchema,
  passLabel: Id.nullable(), optimizerEligible: z.boolean(), criticalInvariantIds: z.array(Id).max(100).default([]),
}).strict().superRefine((entry, context) => {
  if (entry.optimizerEligible !== (entry.panelRole === "correction")) context.addIssue({ code: "custom", path: ["optimizerEligible"], message: "Only correction cases may be optimizer eligible." });
});
export const ContinualBenchIssuePacketSchema = z.object({
  schemaVersion: z.literal("openpond.continualBenchIssuePacket.v1"), id: Id, revision: z.number().int().positive(), contentHash: Hash,
  familyId: Id, familyLabel: z.string().trim().min(1).max(500), severity: z.enum(["low", "medium", "high", "critical"]),
  cases: z.array(ContinualBenchIssueCaseSchema).min(2).max(10_000), duplicateEvidence: ImmutableRef, leakageEvidence: ImmutableRef,
  priorExposureEvidence: ImmutableRef, observedAt: Timestamp, reviewedAt: Timestamp, queuedAt: Timestamp.nullable(), runAt: Timestamp.nullable(),
  createdBy: Id, createdAt: Timestamp,
}).strict().superRefine((packet, context) => {
  if (!packet.cases.some((entry) => entry.panelRole === "correction")) context.addIssue({ code: "custom", path: ["cases"], message: "An issue packet requires a correction case." });
  if (!packet.cases.some((entry) => entry.panelRole === "sibling_verification")) context.addIssue({ code: "custom", path: ["cases"], message: "An issue packet requires a sibling-verification case." });
  if (new Set(packet.cases.map((entry) => entry.taskId)).size !== packet.cases.length) context.addIssue({ code: "custom", path: ["cases"], message: "Issue-packet task ids must be unique." });
});
export const ContinualBenchPanelReleaseSchema = z.object({
  id: Id, role: ContinualBenchPanelRoleSchema, passLabel: Id.nullable(), taskset: VersionedRef,
  familyIds: z.array(Id).min(1).max(100_000), taskCount: z.number().int().positive().max(1_000_000), sealedAt: Timestamp,
}).strict().superRefine((panel, context) => {
  const requiresPass = panel.role === "correction" || panel.role === "sibling_verification" || panel.role === "cumulative_known";
  if (requiresPass !== (panel.passLabel !== null)) context.addIssue({ code: "custom", path: ["passLabel"], message: requiresPass ? "This panel role requires a pass label." : "This panel role is series-wide and cannot carry a pass label." });
});
export const ContinualBenchPolicyIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("base_model"), id: Id, revision: z.string().trim().min(1).max(500), contentHash: Hash }).strict(),
  z.object({ kind: z.literal("model_version"), id: Id, contentHash: Hash }).strict(),
  z.object({ kind: z.literal("external_reference"), id: Id, model: ChatModelRef, providerRevision: z.string().trim().min(1).max(500), contentHash: Hash }).strict(),
]);
export const ContinualBenchScheduleEntrySchema = z.object({
  scheduleEntryId: Id, ordinal: z.number().int().nonnegative(), label: Id,
  role: z.enum(["seed", "daily_residual", "rank_candidate", "weekly_rollup", "full_refresh"]), parentRule: z.enum(["base_model", "previous_release", "seed_release", "accepted_daily_head", "accepted_seed"]),
  trainableRank: z.number().int().positive().max(1_024), correctionPanelIds: z.array(Id).min(1).max(1_000),
  optimizerGroupsPerTask: z.number().int().positive().max(1_000), trajectoriesPerGroup: z.number().int().min(4).max(1_000),
}).strict();
export const ContinualBenchCurrencyThresholdsSchema = z.object({
  revision: z.number().int().positive(), requireAllAttemptsTerminal: z.literal(true), criticalCorrectionPassRate: z.number().min(0).max(1),
  siblingPassRate: z.number().min(0).max(1), behavioralRetentionRate: z.number().min(0).max(1), maximumRetainedRegressionPoints: z.number().min(0).max(100),
  blockCriticalPriorRegression: z.boolean(), authorizedClaims: z.array(z.enum(["systems_complete", "correction_absorbed", "issue_generalized", "continually_current", "frontier_pareto_result"])).min(1).max(5),
}).strict();
export const ContinualBenchmarkProtocolReleaseSchema = z.object({
  schemaVersion: z.literal("openpond.continualBenchmarkProtocol.v1"), id: Id, revision: z.number().int().positive(), contentHash: Hash,
  ownerId: Id, createdAt: Timestamp, sealedAt: Timestamp, creationReceipt: ImmutableRef,
  predecessorSeries: z.object({ id: Id, revision: z.number().int().positive(), contentHash: Hash }).strict().nullable(),
  scenarioPack: ImmutableRef, issueFamilyLedger: ImmutableRef, issuePacketRelease: ImmutableRef,
  panels: z.array(ContinualBenchPanelReleaseSchema).min(6).max(10_000), grader: ImmutableRef,
  judge: z.object({ release: ImmutableRef, rubricRelease: ImmutableRef, calibrationRelease: ImmutableRef, model: ChatModelRef }).strict().nullable(),
  policies: z.object({ base: ContinualBenchPolicyIdentitySchema, master: ContinualBenchPolicyIdentitySchema.nullable(), externalReferences: z.array(ContinualBenchPolicyIdentitySchema).min(1).max(20) }).strict(),
  invariants: z.object({
    systemPromptHash: Hash, toolSchema: ImmutableRef, application: ImmutableRef, harness: ImmutableRef, runtime: ImmutableRef, workerImage: ImmutableRef,
    autoRefiner: z.object({ enabled: z.boolean(), release: ImmutableRef.nullable() }).strict(),
  }).strict(),
  schedule: z.array(ContinualBenchScheduleEntrySchema).min(1).max(1_000),
  evaluation: z.object({ seeds: z.array(z.number().int()).min(3).max(100), repetitions: z.number().int().min(3).max(20), powerRule: ImmutableRef, pairedBootstrapSamples: z.number().int().min(1_000).max(1_000_000), confidenceLevel: z.literal(0.95) }).strict(),
  resources: z.object({ maximumTrainingGpuSeconds: z.number().int().positive(), maximumEvaluationGpuSeconds: z.number().int().positive(), maximumProviderSpendUsd: z.number().positive(), maximumTotalSpendUsd: z.number().positive(), maximumConcurrentGroups: z.number().int().positive().max(1_000) }).strict(),
  currencyThresholds: ContinualBenchCurrencyThresholdsSchema,
}).strict().superRefine((protocol, context) => {
  const panelIds = protocol.panels.map((panel) => panel.id);
  if (new Set(panelIds).size !== panelIds.length) context.addIssue({ code: "custom", path: ["panels"], message: "Protocol panel ids must be unique." });
  for (const role of ["development", "retained", "frozen_final", "training_eligible"] as const) {
    if (protocol.panels.filter((panel) => panel.role === role).length !== 1) context.addIssue({ code: "custom", path: ["panels"], message: `A protocol requires exactly one ${role} panel.` });
  }
  const ordered = [...protocol.schedule].sort((left, right) => left.ordinal - right.ordinal);
  if (ordered.some((entry, index) => entry.ordinal !== index)) context.addIssue({ code: "custom", path: ["schedule"], message: "Protocol schedule ordinals must be contiguous from zero." });
  const known = new Set(panelIds);
  if (protocol.schedule.some((entry) => entry.correctionPanelIds.some((id) => !known.has(id)))) context.addIssue({ code: "custom", path: ["schedule"], message: "Every scheduled correction panel must belong to the protocol." });
});

export type ContinualBenchPanelRole = z.infer<typeof ContinualBenchPanelRoleSchema>;
export type ContinualBenchIssueCase = z.infer<typeof ContinualBenchIssueCaseSchema>;
export type ContinualBenchIssuePacket = z.infer<typeof ContinualBenchIssuePacketSchema>;
export type ContinualBenchPanelRelease = z.infer<typeof ContinualBenchPanelReleaseSchema>;
export type ContinualBenchPolicyIdentity = z.infer<typeof ContinualBenchPolicyIdentitySchema>;
export type ContinualBenchScheduleEntry = z.infer<typeof ContinualBenchScheduleEntrySchema>;
export type ContinualBenchCurrencyThresholds = z.infer<typeof ContinualBenchCurrencyThresholdsSchema>;
export type ContinualBenchmarkProtocolRelease = z.infer<typeof ContinualBenchmarkProtocolReleaseSchema>;
