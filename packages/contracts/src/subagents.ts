import { z } from "zod";
import { ChatModelRefSchema } from "./providers.js";

export const SUBAGENT_BUILT_IN_ROLE_IDS = [
  "coding",
  "research",
  "review",
  "test",
  "docs",
  "planner",
  "summarizer",
] as const;

export const SubagentBuiltInRoleIdSchema = z.enum(SUBAGENT_BUILT_IN_ROLE_IDS);

export type SubagentBuiltInRoleId = z.infer<typeof SubagentBuiltInRoleIdSchema>;

export const SubagentRoleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_-]*$/);

export type SubagentRoleId = z.infer<typeof SubagentRoleIdSchema>;

export const SubagentIsolationModeSchema = z.enum(["none", "worktree", "copy_on_write"]);

export type SubagentIsolationMode = z.infer<typeof SubagentIsolationModeSchema>;

export const SubagentToolPolicySchema = z.enum(["read_only", "workspace_write", "full_tools"]);

export type SubagentToolPolicy = z.infer<typeof SubagentToolPolicySchema>;

export const SubagentPeerMessagesSchema = z.enum(["disabled", "goal_scoped"]);

export type SubagentPeerMessages = z.infer<typeof SubagentPeerMessagesSchema>;

export const SubagentDelegationModeSchema = z.enum(["manual", "balanced", "proactive"]);

export type SubagentDelegationMode = z.infer<typeof SubagentDelegationModeSchema>;

export const SUBAGENT_DEFAULT_HIGH_RISK_PATH_PATTERNS = [
  "(^|/)(package\\.json|bun\\.lockb?|pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|deno\\.lock)$",
  "(^|/)(migrations?|schema|auth|security|permissions?|billing|payments?)(/|$)",
  "(^|/)packages/contracts(/|$)",
] as const;

export const SubagentReviewRoutingPolicySchema = z.object({
  broadEditSurfaceFileThreshold: z.number().int().min(1).max(500).default(8),
  highRiskPathPatterns: z
    .array(z.string().trim().min(1).max(500))
    .max(100)
    .default(() => [...SUBAGENT_DEFAULT_HIGH_RISK_PATH_PATTERNS]),
}).superRefine((policy, ctx) => {
  for (const [index, pattern] of policy.highRiskPathPatterns.entries()) {
    try {
      new RegExp(pattern);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["highRiskPathPatterns", index],
        message: "High-risk path pattern must be a valid regular expression.",
      });
    }
  }
});

export type SubagentReviewRoutingPolicy = z.infer<typeof SubagentReviewRoutingPolicySchema>;

export const SubagentExplorationSteeringPolicySchema = z.object({
  enabled: z.boolean().default(true),
  repeatedSearchThreshold: z.number().int().min(2).max(20).default(2),
  repeatedReadThreshold: z.number().int().min(2).max(20).default(2),
  repeatedCommandThreshold: z.number().int().min(2).max(20).default(2),
});

export type SubagentExplorationSteeringPolicy = z.infer<typeof SubagentExplorationSteeringPolicySchema>;

export const SubagentRunStatusSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "submitted_for_review",
  "needs_revision",
  "needs_user_input",
  "accepted",
  "completed",
  "failed_with_artifacts",
  "failed",
  "cancelled",
  "needs_resume",
  "superseded",
]);

export type SubagentRunStatus = z.infer<typeof SubagentRunStatusSchema>;

export const SUBAGENT_RUNTIME_EVENT_NAMES = [
  "subagent.started",
  "subagent.reported",
  "subagent.submitted",
  "subagent.accepted",
  "subagent.needs_revision",
  "subagent.completed",
  "subagent.progress",
  "subagent.failed",
  "subagent.blocked",
  "subagent.stale",
  "subagent.cancelled",
  "subagent.cleanup",
  "subagent.workspace_retained",
  "subagent.workspace_retention_expiring",
  "subagent.archived",
  "subagent.superseded",
  "subagent.dismissed",
  "subagent.message",
] as const;

export const SubagentRuntimeEventNameSchema = z.enum(SUBAGENT_RUNTIME_EVENT_NAMES);

export type SubagentRuntimeEventName = z.infer<typeof SubagentRuntimeEventNameSchema>;

export type SubagentRolePreset = {
  id: SubagentBuiltInRoleId;
  label: string;
  description: string;
  defaultToolPolicy: SubagentToolPolicy;
};

export const SUBAGENT_ROLE_PRESETS: readonly SubagentRolePreset[] = [
  {
    id: "coding",
    label: "Coding",
    description: "Make scoped code changes and return patch, diff, and test evidence.",
    defaultToolPolicy: "workspace_write",
  },
  {
    id: "research",
    label: "Research",
    description: "Inspect docs, code, web or repo context and return cited findings.",
    defaultToolPolicy: "read_only",
  },
  {
    id: "review",
    label: "Review",
    description: "Inspect diffs or implementation plans and return ranked findings.",
    defaultToolPolicy: "read_only",
  },
  {
    id: "test",
    label: "Test",
    description: "Run or design validation in isolation and return command evidence.",
    defaultToolPolicy: "workspace_write",
  },
  {
    id: "docs",
    label: "Docs",
    description: "Update or draft project documentation in an isolated target.",
    defaultToolPolicy: "workspace_write",
  },
  {
    id: "planner",
    label: "Planner",
    description: "Decompose a goal into child assignments and context packs.",
    defaultToolPolicy: "read_only",
  },
  {
    id: "summarizer",
    label: "Summarizer",
    description: "Compact transcripts, child results, and goal state for parent context.",
    defaultToolPolicy: "read_only",
  },
];

export const SubagentRoleSettingsSchema = z.object({
  id: SubagentRoleIdSchema,
  enabled: z.boolean().default(true),
  modelRef: ChatModelRefSchema.nullable().default(null),
  isolationMode: SubagentIsolationModeSchema.default("copy_on_write"),
  maxConcurrentRuns: z.number().int().min(1).max(16).default(1),
  maxTurns: z.number().int().min(1).max(100).nullable().default(null),
  maxTokens: z.number().int().min(1).max(10_000_000).nullable().default(null),
  toolPolicy: SubagentToolPolicySchema.default("read_only"),
  background: z.boolean().default(true),
  peerMessages: SubagentPeerMessagesSchema.default("goal_scoped"),
  reviewRouting: SubagentReviewRoutingPolicySchema.default(() => SubagentReviewRoutingPolicySchema.parse({})),
  explorationSteering: SubagentExplorationSteeringPolicySchema.default(() =>
    SubagentExplorationSteeringPolicySchema.parse({})
  ),
});

export type SubagentRoleSettings = z.infer<typeof SubagentRoleSettingsSchema>;

export const SubagentPreferencesSchema = z.object({
  enabled: z.boolean().default(true),
  delegationMode: SubagentDelegationModeSchema.default("balanced"),
  defaultModelRef: ChatModelRefSchema.nullable().default(null),
  roles: z
    .array(SubagentRoleSettingsSchema)
    .max(64)
    .default(() => defaultSubagentRoleSettings()),
  maxConcurrentRuns: z.number().int().min(1).max(32).default(4),
  maxConcurrentRunsPerProvider: z.number().int().min(1).max(32).nullable().default(2),
  maxConcurrentRunsPerWorkspaceTarget: z.number().int().min(1).max(32).nullable().default(2),
  maxTokens: z.number().int().min(1).max(50_000_000).nullable().default(null),
  heartbeatIntervalSeconds: z.number().int().min(10).max(3600).default(60),
}).transform((preferences) => ({
  ...preferences,
  roles: normalizeSubagentRoleSettings(preferences.roles),
}));

export type SubagentPreferences = z.infer<typeof SubagentPreferencesSchema>;

export const SubagentRefSchema = z.object({
  kind: z.enum(["session", "turn", "file", "diff", "artifact"]),
  id: z.string().trim().min(1).max(500),
  label: z.string().trim().min(1).max(500),
});

export type SubagentRef = z.infer<typeof SubagentRefSchema>;

export const SubagentEvidenceRetentionPolicySchema = z.object({
  kind: z.enum(["retain_with_parent"]).default("retain_with_parent"),
  messageRetentionDays: z.number().int().min(1).max(3650).nullable().default(null),
  artifactRetentionDays: z.number().int().min(1).max(3650).nullable().default(null),
  cleanupAfterExpiry: z.boolean().default(false),
}).default(() => ({
  kind: "retain_with_parent" as const,
  messageRetentionDays: null,
  artifactRetentionDays: null,
  cleanupAfterExpiry: false,
}));

export type SubagentEvidenceRetentionPolicy = z.infer<typeof SubagentEvidenceRetentionPolicySchema>;

export const SubagentWorkerBriefSchema = z.object({
  plan: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  targetFiles: z.array(z.string().trim().min(1).max(1000)).max(200).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).max(100).default([]),
  validationCommands: z.array(z.string().trim().min(1).max(2000)).max(100).default([]),
  stopConditions: z.array(z.string().trim().min(1).max(2000)).max(100).default([]),
}).default(() => ({
  plan: [],
  targetFiles: [],
  acceptanceCriteria: [],
  validationCommands: [],
  stopConditions: [],
}));

export type SubagentWorkerBrief = z.infer<typeof SubagentWorkerBriefSchema>;

export const SubagentProgressPhaseSchema = z.enum(["orient", "edit", "validate", "report", "submitted"]);

export type SubagentProgressPhase = z.infer<typeof SubagentProgressPhaseSchema>;

export const SubagentValidationAttemptSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  status: z.enum(["passed", "failed", "unknown"]).default("unknown"),
  exitCode: z.number().int().nullable().default(null),
  outputSummary: z.string().trim().max(5000).nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

export type SubagentValidationAttempt = z.infer<typeof SubagentValidationAttemptSchema>;

export const SubagentReviewPacketQualityEvidenceSchema = z.object({
  finalSummaryPresent: z.boolean().default(false),
  finalSummaryLength: z.number().int().min(0).default(0),
  requestedValidationCommandCount: z.number().int().min(0).default(0),
  validationAttemptCount: z.number().int().min(0).default(0),
  failedValidationCount: z.number().int().min(0).default(0),
  testsRunCount: z.number().int().min(0).default(0),
  changedFileCount: z.number().int().min(0).default(0),
  patchRefPresent: z.boolean().default(false),
  diffRefPresent: z.boolean().default(false),
  artifactCount: z.number().int().min(0).default(0),
  findingCount: z.number().int().min(0).default(0),
  blockerCount: z.number().int().min(0).default(0),
  unvalidatedWorkspaceChanges: z.boolean().default(false),
}).default(() => ({
  finalSummaryPresent: false,
  finalSummaryLength: 0,
  requestedValidationCommandCount: 0,
  validationAttemptCount: 0,
  failedValidationCount: 0,
  testsRunCount: 0,
  changedFileCount: 0,
  patchRefPresent: false,
  diffRefPresent: false,
  artifactCount: 0,
  findingCount: 0,
  blockerCount: 0,
  unvalidatedWorkspaceChanges: false,
}));

export type SubagentReviewPacketQualityEvidence = z.infer<typeof SubagentReviewPacketQualityEvidenceSchema>;

export const SubagentReviewPacketQualitySchema = z.object({
  status: z.enum(["reviewable", "weak", "incomplete"]).default("reviewable"),
  issues: z.array(z.string().trim().min(1).max(5000)).max(100).default([]),
  warnings: z.array(z.string().trim().min(1).max(5000)).max(100).default([]),
  evidence: SubagentReviewPacketQualityEvidenceSchema,
}).default(() => ({
  status: "reviewable" as const,
  issues: [],
  warnings: [],
  evidence: {
    finalSummaryPresent: false,
    finalSummaryLength: 0,
    requestedValidationCommandCount: 0,
    validationAttemptCount: 0,
    failedValidationCount: 0,
    testsRunCount: 0,
    changedFileCount: 0,
    patchRefPresent: false,
    diffRefPresent: false,
    artifactCount: 0,
    findingCount: 0,
    blockerCount: 0,
    unvalidatedWorkspaceChanges: false,
  },
}));

export type SubagentReviewPacketQuality = z.infer<typeof SubagentReviewPacketQualitySchema>;

export const SubagentReviewRoutingEvidenceSchema = z.object({
  packetQualityStatus: z.enum(["reviewable", "weak", "incomplete"]).default("reviewable"),
  confidence: z.enum(["low", "medium", "high"]).nullable().default(null),
  changedFileCount: z.number().int().min(0).default(0),
  highRiskFileCount: z.number().int().min(0).default(0),
  validationAttemptCount: z.number().int().min(0).default(0),
  failedValidationCount: z.number().int().min(0).default(0),
  missingRequestedValidation: z.boolean().default(false),
  providerFailureAfterChanges: z.boolean().default(false),
  userRequestedIndependentReview: z.boolean().default(false),
}).default(() => ({
  packetQualityStatus: "reviewable" as const,
  confidence: null,
  changedFileCount: 0,
  highRiskFileCount: 0,
  validationAttemptCount: 0,
  failedValidationCount: 0,
  missingRequestedValidation: false,
  providerFailureAfterChanges: false,
  userRequestedIndependentReview: false,
}));

export type SubagentReviewRoutingEvidence = z.infer<typeof SubagentReviewRoutingEvidenceSchema>;

export const SubagentReviewRoutingReasonSchema = z.enum([
  "packet_quality_incomplete",
  "packet_quality_weak",
  "low_confidence",
  "validation_failed",
  "validation_missing",
  "broad_edit_surface",
  "high_risk_files",
  "provider_failure_after_changes",
  "user_requested_independent_review",
]);

export type SubagentReviewRoutingReason = z.infer<typeof SubagentReviewRoutingReasonSchema>;

export const SubagentProgressSchema = z.object({
  phase: SubagentProgressPhaseSchema.default("orient"),
  inspectedFiles: z.array(z.string().trim().min(1).max(1000)).max(500).default([]),
  inspectedResources: z.array(z.string().trim().min(1).max(1000)).max(500).default([]),
  repeatedSearches: z.array(z.string().trim().min(1).max(1000)).max(200).default([]),
  repeatedReads: z.array(z.string().trim().min(1).max(1000)).max(200).default([]),
  repeatedCommands: z.array(z.string().trim().min(1).max(1000)).max(200).default([]),
  changedFiles: z.array(z.string().trim().min(1).max(1000)).max(500).default([]),
  patchRefs: z.array(SubagentRefSchema).max(100).default([]),
  validationAttempts: z.array(SubagentValidationAttemptSchema).max(100).default([]),
  latestMeaningfulActivity: z.string().trim().max(5000).nullable().default(null),
  currentBlocker: z.string().trim().max(5000).nullable().default(null),
  updatedAt: z.string().nullable().default(null),
}).default(() => ({
  phase: "orient" as const,
  inspectedFiles: [],
  inspectedResources: [],
  repeatedSearches: [],
  repeatedReads: [],
  repeatedCommands: [],
  changedFiles: [],
  patchRefs: [],
  validationAttempts: [],
  latestMeaningfulActivity: null,
  currentBlocker: null,
  updatedAt: null,
}));

export type SubagentProgress = z.infer<typeof SubagentProgressSchema>;

export const SubagentReviewStateSchema = z.object({
  status: z.enum([
    "pending",
    "submitted_for_review",
    "needs_revision",
    "accepted",
    "needs_user_input",
    "failed_with_artifacts",
    "dismissed",
  ]).default("pending"),
  submittedAt: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
  reviewerSessionId: z.string().trim().min(1).max(200).nullable().default(null),
  summary: z.string().trim().max(20_000).nullable().default(null),
  issues: z.array(z.string().trim().min(1).max(5000)).max(200).default([]),
  requiredCorrections: z.array(z.string().trim().min(1).max(5000)).max(200).default([]),
  humanReviewRecommended: z.boolean().default(false),
  independentReviewRecommended: z.boolean().default(false),
  reviewerRoutingReasons: z.array(SubagentReviewRoutingReasonSchema).max(50).default([]),
  reviewerRoutingEvidence: SubagentReviewRoutingEvidenceSchema,
  packetQuality: SubagentReviewPacketQualitySchema,
}).default(() => ({
  status: "pending" as const,
  submittedAt: null,
  decidedAt: null,
  reviewerSessionId: null,
  summary: null,
  issues: [],
  requiredCorrections: [],
  humanReviewRecommended: false,
  independentReviewRecommended: false,
  reviewerRoutingReasons: [],
  reviewerRoutingEvidence: {
    packetQualityStatus: "reviewable" as const,
    confidence: null,
    changedFileCount: 0,
    highRiskFileCount: 0,
    validationAttemptCount: 0,
    failedValidationCount: 0,
    missingRequestedValidation: false,
    providerFailureAfterChanges: false,
    userRequestedIndependentReview: false,
  },
  packetQuality: {
    status: "reviewable" as const,
    issues: [],
    warnings: [],
    evidence: {
      finalSummaryPresent: false,
      finalSummaryLength: 0,
      requestedValidationCommandCount: 0,
      validationAttemptCount: 0,
      failedValidationCount: 0,
      testsRunCount: 0,
      changedFileCount: 0,
      patchRefPresent: false,
      diffRefPresent: false,
      artifactCount: 0,
      findingCount: 0,
      blockerCount: 0,
      unvalidatedWorkspaceChanges: false,
    },
  },
}));

export type SubagentReviewState = z.infer<typeof SubagentReviewStateSchema>;

export const SubagentReportSchema = z.object({
  summary: z.string().trim().max(20_000).default(""),
  findings: z.array(z.string().trim().min(1).max(5000)).max(200).default([]),
  artifacts: z.array(SubagentRefSchema).max(200).default([]),
  patchRef: SubagentRefSchema.nullable().default(null),
  diffRef: SubagentRefSchema.nullable().default(null),
  testsRun: z.array(z.string().trim().min(1).max(2000)).max(100).default([]),
  blockers: z.array(z.string().trim().min(1).max(5000)).max(100).default([]),
  confidence: z.enum(["low", "medium", "high"]).nullable().default(null),
  followUpNeeded: z.boolean().default(false),
});

export type SubagentReport = z.infer<typeof SubagentReportSchema>;

export const SubagentRunSchema = z.object({
  id: z.string().trim().min(1).max(200),
  parentSessionId: z.string().trim().min(1).max(200),
  parentTurnId: z.string().trim().min(1).max(200).nullable().default(null),
  parentGoalId: z.string().trim().min(1).max(200).nullable().default(null),
  childSessionId: z.string().trim().min(1).max(200).nullable().default(null),
  roleId: SubagentRoleIdSchema,
  objective: z.string().trim().min(1).max(50_000),
  modelRef: ChatModelRefSchema.nullable().default(null),
  isolationMode: SubagentIsolationModeSchema.default("copy_on_write"),
  toolPolicy: SubagentToolPolicySchema.default("read_only"),
  background: z.boolean().default(true),
  peerMessages: SubagentPeerMessagesSchema.default("goal_scoped"),
  status: SubagentRunStatusSchema.default("queued"),
  required: z.boolean().default(true),
  workerBrief: SubagentWorkerBriefSchema,
  progress: SubagentProgressSchema,
  review: SubagentReviewStateSchema,
  evidenceRetention: SubagentEvidenceRetentionPolicySchema,
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  report: SubagentReportSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type SubagentRun = z.infer<typeof SubagentRunSchema>;

export const SubagentLifecycleActionSchema = z.enum(["cleanup", "archive", "cleanup_and_archive"]);

export type SubagentLifecycleAction = z.infer<typeof SubagentLifecycleActionSchema>;

export const SubagentLifecycleActionRequestSchema = z.object({
  action: SubagentLifecycleActionSchema,
  reason: z.string().trim().min(1).max(2000).nullable().default(null),
});

export type SubagentLifecycleActionRequest = z.infer<typeof SubagentLifecycleActionRequestSchema>;

export const SubagentLifecycleActionResponseSchema = z.object({
  action: SubagentLifecycleActionSchema,
  run: SubagentRunSchema,
  workspaceCleanup: z.record(z.string(), z.unknown()).nullable().default(null),
  sessionArchive: z.record(z.string(), z.unknown()).nullable().default(null),
  nextStep: z.string(),
});

export type SubagentLifecycleActionResponse = z.infer<typeof SubagentLifecycleActionResponseSchema>;

export const SubagentMessageKindSchema = z.enum([
  "question",
  "answer",
  "handoff",
  "artifact",
  "status",
  "blocker",
]);

export type SubagentMessageKind = z.infer<typeof SubagentMessageKindSchema>;

export const SubagentMessagePrioritySchema = z.enum(["normal", "interrupt"]);

export type SubagentMessagePriority = z.infer<typeof SubagentMessagePrioritySchema>;

export const SubagentMessageDeliverySchema = z.object({
  status: z.enum(["pending", "delivered", "undelivered"]).default("pending"),
  deliveredRunIds: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  acknowledgedRunIds: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  deliveredParentSessionId: z.string().trim().min(1).max(200).nullable().default(null),
  acknowledgedParentSessionId: z.string().trim().min(1).max(200).nullable().default(null),
  wakeRequestedParentSessionId: z.string().trim().min(1).max(200).nullable().default(null),
  wakeQueuedParentSessionId: z.string().trim().min(1).max(200).nullable().default(null),
  wakeDeferredParentSessionId: z.string().trim().min(1).max(200).nullable().default(null),
  wakeParentReason: z.string().trim().min(1).max(1000).nullable().default(null),
  wakeRequestedRunIds: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  wakeInterruptedRunIds: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  wakeDeferredRunIds: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  reason: z.string().trim().min(1).max(1000).nullable().default(null),
});

export type SubagentMessageDelivery = z.infer<typeof SubagentMessageDeliverySchema>;

export const SubagentMessageSchema = z.object({
  id: z.string().trim().min(1).max(200),
  parentGoalId: z.string().trim().min(1).max(200).nullable().default(null),
  fromRunId: z.string().trim().min(1).max(200),
  toRunId: z.string().trim().min(1).max(200).nullable().default(null),
  toRole: SubagentRoleIdSchema.nullable().default(null),
  kind: SubagentMessageKindSchema,
  priority: SubagentMessagePrioritySchema.optional(),
  body: z.string().trim().min(1).max(50_000),
  refs: z.array(SubagentRefSchema).max(100).default([]),
  delivery: SubagentMessageDeliverySchema.optional(),
  createdAt: z.string(),
});

export type SubagentMessage = z.infer<typeof SubagentMessageSchema>;

export function defaultSubagentRoleSettings(): SubagentRoleSettings[] {
  return SUBAGENT_ROLE_PRESETS.map((preset) =>
    SubagentRoleSettingsSchema.parse({
      id: preset.id,
      toolPolicy: preset.defaultToolPolicy,
    }),
  );
}

export function defaultSubagentPreferences(): SubagentPreferences {
  return SubagentPreferencesSchema.parse({});
}

export function normalizeSubagentRoleSettings(
  roles: readonly SubagentRoleSettings[] | null | undefined,
): SubagentRoleSettings[] {
  const builtIns = defaultSubagentRoleSettings();
  const roleById = new Map<string, SubagentRoleSettings>(builtIns.map((role) => [role.id, role]));
  const customRoles: SubagentRoleSettings[] = [];
  for (const role of roles ?? []) {
    const normalized = SubagentRoleSettingsSchema.parse(role);
    if (roleById.has(normalized.id)) {
      roleById.set(normalized.id, normalized);
    } else {
      customRoles.push(normalized);
    }
  }
  return [...builtIns.map((role) => roleById.get(role.id) ?? role), ...customRoles];
}

export function subagentRoleSettingsById(
  preferences: SubagentPreferences | null | undefined,
  roleId: string,
): SubagentRoleSettings | null {
  const normalized = SubagentPreferencesSchema.parse(preferences ?? {});
  return normalized.roles.find((role) => role.id === roleId) ?? null;
}

export function mergeSubagentRoleSettings(
  current: readonly SubagentRoleSettings[],
  nextRole: SubagentRoleSettings,
): SubagentRoleSettings[] {
  const normalizedRole = SubagentRoleSettingsSchema.parse(nextRole);
  let replaced = false;
  const roles = current.map((role) => {
    if (role.id !== normalizedRole.id) return SubagentRoleSettingsSchema.parse(role);
    replaced = true;
    return normalizedRole;
  });
  return replaced ? roles : [...roles, normalizedRole];
}
