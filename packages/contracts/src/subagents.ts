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

export const SubagentRunStatusSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "needs_resume",
]);

export type SubagentRunStatus = z.infer<typeof SubagentRunStatusSchema>;

export const SUBAGENT_RUNTIME_EVENT_NAMES = [
  "subagent.started",
  "subagent.reported",
  "subagent.completed",
  "subagent.progress",
  "subagent.failed",
  "subagent.blocked",
  "subagent.cancelled",
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
});

export type SubagentRoleSettings = z.infer<typeof SubagentRoleSettingsSchema>;

export const SubagentPreferencesSchema = z.object({
  enabled: z.boolean().default(true),
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
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  report: SubagentReportSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type SubagentRun = z.infer<typeof SubagentRunSchema>;

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
