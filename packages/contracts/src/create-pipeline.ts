import { z } from "zod";

const NullableStringSchema = z.string().trim().min(1).nullable();
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const CreateImproveSurfaceSchema = z.enum([
  "direct_prompt_create",
  "context_backed_create",
  "create_as_agent",
  "workflow_suggestion",
  "local_extend",
  "hosted_create",
  "local_import",
  "direct_prompt_improve",
  "context_backed_improve",
  "hosted_improve",
  "lab_create",
  "lab_improve",
  "training",
]);

export const CreateImproveCommandSchema = z.enum([
  "/create",
  "/edit",
  "openpond extend",
  "create_as_agent",
  "suggest_workflow",
  "local_import",
  "lab_create",
  "lab_improve",
  "training",
]);

export const CreateImproveOperationSchema = z.enum([
  "create",
  "improve",
  "import",
  "promote",
]);

export const CreateImproveStateSchema = z.enum([
  "planning",
  "awaiting_questions",
  "awaiting_plan_approval",
  "paused",
  "applying_source",
  "running_checks",
  "evaluating",
  "awaiting_promotion",
  "opening_pull_request",
  "pull_request_open",
  "reconciling_release",
  "released",
  "rejected",
  "ready",
  "ready_local",
  "pushing_hosted",
  "running_hosted_checks",
  "published_hosted",
  "blocked",
  "failed",
  "cancelled",
]);

export const CreateImproveConfirmationPolicySchema = z.enum([
  "always_require_plan_approval",
  "approval_already_granted",
]);

export const CreateImproveSourceAuthoritySchema = z.enum([
  "local_profile",
  "hosted_profile",
  "promote_local_to_hosted",
  "managed_artifact",
]);

export const CreateImproveExecutionAdapterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    sourceAuthority: z.literal("local_profile"),
    activeProfile: z.string().trim().min(1).nullable(),
    repoPath: NullableStringSchema,
    sourcePath: NullableStringSchema,
    localHead: NullableStringSchema,
    confirmationPolicy: CreateImproveConfirmationPolicySchema.default(
      "always_require_plan_approval",
    ),
  }),
  z.object({
    kind: z.literal("hosted"),
    sourceAuthority: z.literal("hosted_profile"),
    teamId: NullableStringSchema,
    projectId: NullableStringSchema,
    activeProfile: z.string().trim().min(1).nullable(),
    sourceRef: NullableStringSchema,
    baseSha: NullableStringSchema,
    workItemId: NullableStringSchema,
    confirmationPolicy: CreateImproveConfirmationPolicySchema.default(
      "always_require_plan_approval",
    ),
  }),
  z.object({
    kind: z.literal("promote_local_to_hosted"),
    sourceAuthority: z.literal("promote_local_to_hosted"),
    teamId: NullableStringSchema,
    projectId: NullableStringSchema,
    activeProfile: z.string().trim().min(1).nullable(),
    repoPath: NullableStringSchema,
    sourcePath: NullableStringSchema,
    localHead: NullableStringSchema,
    hostedHead: NullableStringSchema,
    sourceRef: NullableStringSchema,
    confirmationPolicy: CreateImproveConfirmationPolicySchema.default(
      "always_require_plan_approval",
    ),
  }),
  z.object({
    kind: z.literal("managed_artifact"),
    sourceAuthority: z.literal("managed_artifact"),
    activeProfile: z.string().trim().min(1).nullable(),
    confirmationPolicy: CreateImproveConfirmationPolicySchema.default(
      "always_require_plan_approval",
    ),
  }),
]);

export const CreateImproveActorSchema = z.object({
  id: NullableStringSchema,
  kind: z.enum(["user", "system", "automation"]).default("user"),
  label: NullableStringSchema,
});

export const CreateImproveScopeSchema = z.object({
  profileId: z.string().trim().min(1),
  conversationId: NullableStringSchema,
  originTurnId: NullableStringSchema,
  workItemId: NullableStringSchema,
  projectId: NullableStringSchema,
  targetProject: z
    .object({
      id: NullableStringSchema,
      name: NullableStringSchema,
      workspacePath: NullableStringSchema,
      sourceRef: NullableStringSchema,
      baseSha: NullableStringSchema,
    })
    .nullable(),
});

export const CreateImproveContextSchema = z.object({
  messageIds: z.array(z.string().trim().min(1)).default([]),
  conversationExcerpts: z
    .array(
      z.object({
        messageId: NullableStringSchema,
        role: z.string().trim().min(1).nullable(),
        excerpt: z.string().trim().min(1),
        reason: z.string().trim().min(1).nullable(),
      }),
    )
    .default([]),
  attachments: z
    .array(
      z.object({
        id: NullableStringSchema,
        name: z.string().trim().min(1),
        mediaType: NullableStringSchema,
        ref: NullableStringSchema,
      }),
    )
    .default([]),
  apps: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
        connectionId: NullableStringSchema,
        required: z.boolean().default(false),
      }),
    )
    .default([]),
  tools: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        inputSummary: NullableStringSchema,
        outputSummary: NullableStringSchema,
        artifactRefs: z.array(z.string().trim().min(1)).default([]),
        sideEffects: z.array(z.string().trim().min(1)).default([]),
      }),
    )
    .default([]),
  signalRefs: z.array(z.string().trim().min(1)).default([]),
  evalRefs: z.array(z.string().trim().min(1)).default([]),
  targetRepoAssumptions: z.array(z.string().trim().min(1)).default([]),
});

const CreateImproveTargetBase = {
  id: NullableStringSchema,
  displayName: NullableStringSchema,
};

export const CreateImproveTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unselected"),
    ...CreateImproveTargetBase,
  }),
  z.object({
    kind: z.literal("agent"),
    ...CreateImproveTargetBase,
    defaultActionKey: NullableStringSchema,
  }),
  z.object({
    kind: z.literal("skill"),
    ...CreateImproveTargetBase,
    skillName: NullableStringSchema,
  }),
  z.object({
    kind: z.literal("extension"),
    ...CreateImproveTargetBase,
    slot: NullableStringSchema,
  }),
  z.object({
    kind: z.literal("model"),
    ...CreateImproveTargetBase,
    trainingPlanId: NullableStringSchema,
    trainingJobId: NullableStringSchema,
    artifactId: NullableStringSchema,
  }),
  z.object({
    kind: z.literal("configuration"),
    ...CreateImproveTargetBase,
    key: NullableStringSchema,
  }),
]);

export const CreateImproveTargetKindSchema = z.enum([
  "agent",
  "skill",
  "extension",
  "model",
  "configuration",
]);

export const CreateImproveEvidenceSnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.createImprove.evidenceSnapshot.v1"),
  id: z.string().trim().min(1),
  contentHash: z.string().trim().min(8),
  consent: z.object({
    status: z.enum(["granted", "denied", "revoked"]),
    scope: z.enum(["metadata_only", "selected_turns", "full_session", "direct_intent"]),
    reviewedBy: NullableStringSchema,
    reviewedAt: z.string().trim().min(1),
  }),
  sources: z.array(z.object({
    kind: z.enum(["signal", "conversation", "direct_correction", "manual_intent", "artifact"]),
    id: z.string().trim().min(1),
    sourceHash: z.string().trim().min(8),
    excerptRef: NullableStringSchema,
  })).min(1),
  reviewerIntent: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  metadata: MetadataSchema,
});

export const CreateImproveTasksetRefSchema = z.object({
  schemaVersion: z.literal("openpond.createImprove.tasksetRef.v1"),
  id: z.string().trim().min(1),
  revision: z.number().int().positive(),
  contentHash: z.string().trim().min(8),
  evidenceSnapshotIds: z.array(z.string().trim().min(1)).min(1),
  policyBoundary: z.object({
    policyVisibleFields: z.array(z.string().trim().min(1)).default([]),
    privilegedFields: z.array(z.string().trim().min(1)).default([]),
    hiddenGraderRefs: z.array(z.string().trim().min(1)).default([]),
    connectedAppScopes: z.array(z.string().trim().min(1)).default([]),
  }),
  targetRecommendation: z.object({
    kind: CreateImproveTargetKindSchema,
    rationale: z.array(z.string().trim().min(1)).min(1),
    confidence: z.number().min(0).max(1),
  }),
  authoringSplitRefs: z.array(z.string().trim().min(1)).default([]),
  privateSplitRefs: z.array(z.string().trim().min(1)).default([]),
  approvedBy: NullableStringSchema,
  approvedAt: z.string().trim().min(1),
  metadata: MetadataSchema,
});

export const CreateImproveRequirementSchema = z.object({
  kind: z.enum([
    "npm_package",
    "runtime_tool",
    "setup_command",
    "secret",
    "integration",
    "volume",
    "target_project",
    "external_service",
  ]),
  name: z.string().trim().min(1),
  status: z.enum(["declared", "required", "blocked", "satisfied"]).default("declared"),
  detail: NullableStringSchema,
  metadata: MetadataSchema,
});

export const CreateImproveActionShapeSchema = z.object({
  mode: z.enum(["chat", "direct_action", "chat_and_direct_actions"]),
  label: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  defaultActionKey: NullableStringSchema,
  directActionHint: NullableStringSchema,
  artifactPolicy: z.string().trim().min(1),
});

export const CreateImprovePlanSchema = z.object({
  schemaVersion: z.literal("openpond.createImprove.plan.v1"),
  id: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  status: z
    .enum(["draft", "pending_approval", "approved", "rejected", "cancelled", "superseded"])
    .default("pending_approval"),
  objective: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  capturedContextSummary: z.string().trim().min(1),
  defaultChatAction: z.object({
    key: NullableStringSchema,
    label: NullableStringSchema,
    required: z.boolean().default(true),
  }),
  sourcePlan: z
    .array(
      z.object({
        path: z.string().trim().min(1),
        operation: z.enum(["create", "update", "delete", "inspect"]),
        reason: z.string().trim().min(1),
      }),
    )
    .default([]),
  requirements: z.array(CreateImproveRequirementSchema).default([]),
  checks: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        command: z.string().trim().min(1),
        required: z.boolean().default(true),
      }),
    )
    .default([]),
  approvalId: NullableStringSchema,
  approvedAt: NullableStringSchema,
  editedFromPlanId: NullableStringSchema,
  metadata: MetadataSchema,
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

export const CreateImproveQuestionOptionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  value: z.string().trim().min(1),
  description: NullableStringSchema,
  metadata: MetadataSchema,
});

export const CreateImproveQuestionAnswerSchema = z.object({
  value: z.string().trim().min(1),
  label: NullableStringSchema,
  detail: NullableStringSchema,
  answeredAt: z.string().trim().min(1),
  metadata: MetadataSchema,
});

export const CreateImproveQuestionSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(["single_choice", "free_text"]).default("single_choice"),
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  required: z.boolean().default(true),
  status: z.enum(["pending", "answered", "skipped"]).default("pending"),
  options: z.array(CreateImproveQuestionOptionSchema).default([]),
  answer: CreateImproveQuestionAnswerSchema.nullable().default(null),
  metadata: MetadataSchema,
});

export const CreateImproveWorkflowCaptureSchema = z.object({
  schemaVersion: z.literal("openpond.createImprove.workflowCapture.v1"),
  id: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  command: CreateImproveCommandSchema,
  objective: z.string().trim().min(1),
  conversationExcerpts: CreateImproveContextSchema.shape.conversationExcerpts,
  attachments: CreateImproveContextSchema.shape.attachments,
  apps: CreateImproveContextSchema.shape.apps,
  tools: CreateImproveContextSchema.shape.tools,
  sideEffects: z.array(z.string().trim().min(1)).default([]),
  profileActions: z.array(z.string().trim().min(1)).default([]),
  externalProviders: z.array(z.string().trim().min(1)).default([]),
  environmentVariables: z.array(z.string().trim().min(1)).default([]),
  files: z.array(z.string().trim().min(1)).default([]),
  schedules: z.array(z.string().trim().min(1)).default([]),
  webhooks: z.array(z.string().trim().min(1)).default([]),
  channelTargets: z.array(z.string().trim().min(1)).default([]),
  outputArtifacts: z.array(z.string().trim().min(1)).default([]),
  targetRepoAssumptions: z.array(z.string().trim().min(1)).default([]),
  traceRefs: z.array(z.string().trim().min(1)).default([]),
  metadata: MetadataSchema,
  createdAt: z.string().trim().min(1),
});

export const CreateImprovePullRequestSchema = z.object({
  provider: z.literal("github"),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["open", "merged", "closed"]),
  baseBranch: z.string().trim().min(1),
  headBranch: z.string().trim().min(1),
  mergeCommit: NullableStringSchema,
  openedAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

export const CreateImproveGitCandidateSchema = z.object({
  baseBranch: z.string().trim().min(1),
  baseCommit: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  headCommit: NullableStringSchema,
  remoteName: z.string().trim().min(1).default("origin"),
  remoteUrl: NullableStringSchema,
  worktreePath: NullableStringSchema,
  changedPaths: z.array(z.string().trim().min(1)).default([]),
  diffStat: NullableStringSchema,
  pullRequest: CreateImprovePullRequestSchema.nullable().default(null),
});

export const CreateImproveCandidateSchema = z.object({
  id: z.string().trim().min(1),
  target: CreateImproveTargetSchema,
  status: z.enum(["draft", "authored", "checking", "evaluated", "accepted", "rejected", "failed"]),
  git: CreateImproveGitCandidateSchema.nullable().default(null),
  parentCandidateId: NullableStringSchema.default(null),
  tasksetRef: CreateImproveTasksetRefSchema.nullable().default(null),
  authoringModelRef: NullableStringSchema.default(null),
  allowedPaths: z.array(z.string().trim().min(1)).default([]),
  sourceRefs: z.array(z.string().trim().min(1)).default([]),
  artifactRefs: z.array(z.string().trim().min(1)).default([]),
  checkRefs: z.array(z.string().trim().min(1)).default([]),
  evaluationReceiptRefs: z.array(z.string().trim().min(1)).default([]),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  metadata: MetadataSchema,
});

export const CreateImproveEvaluationReceiptSchema = z.object({
  id: z.string().trim().min(1),
  candidateId: NullableStringSchema,
  target: CreateImproveTargetSchema,
  evaluatorKind: z
    .enum(["agent_sdk", "taskset", "extension", "skill", "configuration", "checks"])
    .default("checks"),
  subject: z
    .enum(["active", "candidate", "post_release", "standalone"])
    .default("standalone"),
  sourceCommit: NullableStringSchema.default(null),
  sourceBranch: NullableStringSchema.default(null),
  tasksetId: NullableStringSchema.default(null),
  tasksetHash: NullableStringSchema.default(null),
  taskAttemptRefs: z.array(z.string().trim().min(1)).default([]),
  status: z.enum(["pending", "passed", "failed", "blocked"]),
  publishGate: z.enum(["passed", "failed", "not_applicable"]).default("not_applicable"),
  summaryCounts: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).nullable().default(null),
  evalRefs: z.array(z.string().trim().min(1)).default([]),
  artifactRefs: z.array(z.string().trim().min(1)).default([]),
  summary: NullableStringSchema,
  createdAt: z.string().trim().min(1),
  metadata: MetadataSchema,
});

export const CreateImproveExecutionPolicySchema = z.object({
  mode: z.enum(["foreground", "background"]).default("background"),
  pauseAllowed: z.boolean().default(true),
  cancellationAllowed: z.boolean().default(true),
});

export const CreateImproveIterationPolicySchema = z.object({
  mode: z.enum(["single", "bounded", "until_evals_pass"]).default("single"),
  maximumAttempts: z.number().int().min(1).max(20).default(1),
  currentAttempt: z.number().int().min(0).max(20).default(0),
});

export const CreateImproveExternalExecutionRefSchema = z.object({
  kind: z.enum(["candidate_authoring", "local_apply", "hosted_work_item", "training_job", "evaluation", "pull_request", "release"]),
  id: z.string().trim().min(1),
  status: NullableStringSchema,
  metadata: MetadataSchema,
});

export const CreateImproveReleaseOutcomeSchema = z.object({
  status: z.enum(["not_requested", "pending", "released", "rejected", "rolled_back"]),
  profileCommit: NullableStringSchema,
  profileTag: NullableStringSchema,
  releaseReceiptRef: NullableStringSchema,
  pullRequest: CreateImprovePullRequestSchema.nullable().default(null),
  updatedAt: NullableStringSchema,
});

export const CreateImproveRunSchema = z.object({
  schemaVersion: z.literal("openpond.createImprove.run.v1"),
  id: z.string().trim().min(1),
  revision: z.number().int().nonnegative(),
  operation: CreateImproveOperationSchema,
  surface: CreateImproveSurfaceSchema,
  command: CreateImproveCommandSchema,
  objective: z.string().trim().min(1),
  state: CreateImproveStateSchema,
  adapter: CreateImproveExecutionAdapterSchema,
  actor: CreateImproveActorSchema,
  scope: CreateImproveScopeSchema,
  context: CreateImproveContextSchema,
  target: CreateImproveTargetSchema,
  evidenceSnapshots: z.array(CreateImproveEvidenceSnapshotSchema).default([]),
  tasksetRef: CreateImproveTasksetRefSchema.nullable().default(null),
  targetSelection: z.object({
    status: z.enum(["open", "recommended", "confirmed"]),
    preselectedKind: CreateImproveTargetKindSchema.nullable(),
    confirmedKind: CreateImproveTargetKindSchema.nullable(),
  }).nullable().default(null),
  plan: CreateImprovePlanSchema.nullable(),
  workflowCapture: CreateImproveWorkflowCaptureSchema.nullable(),
  executionPolicy: CreateImproveExecutionPolicySchema.default({
    mode: "background",
    pauseAllowed: true,
    cancellationAllowed: true,
  }),
  iterationPolicy: CreateImproveIterationPolicySchema.default({
    mode: "single",
    maximumAttempts: 1,
    currentAttempt: 0,
  }),
  approvalIds: z.array(z.string().trim().min(1)).default([]),
  questionIds: z.array(z.string().trim().min(1)).default([]),
  questions: z.array(CreateImproveQuestionSchema).default([]),
  candidates: z.array(CreateImproveCandidateSchema).default([]),
  evaluationReceipts: z.array(CreateImproveEvaluationReceiptSchema).default([]),
  checkRefs: z.array(z.string().trim().min(1)).default([]),
  sourceRefs: z.array(z.string().trim().min(1)).default([]),
  externalExecutionRefs: z.array(CreateImproveExternalExecutionRefSchema).default([]),
  localProfileCommit: NullableStringSchema,
  hostedSourceCommit: NullableStringSchema,
  hostedSourceRef: NullableStringSchema,
  releaseOutcome: CreateImproveReleaseOutcomeSchema.default({
    status: "not_requested",
    profileCommit: null,
    profileTag: null,
    releaseReceiptRef: null,
    pullRequest: null,
    updatedAt: null,
  }),
  blockedReason: NullableStringSchema,
  appliedActionIds: z.array(z.string().trim().min(1)).max(200).default([]),
  metadata: MetadataSchema,
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

const CreateImproveActionBase = {
  runId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  actionId: z.string().trim().min(1),
};

export const CreateImproveRunActionSchema = z.discriminatedUnion("type", [
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("answer_question"),
    questionId: z.string().trim().min(1),
    value: z.string().trim().min(1),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("approve_plan"),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("revise_plan"),
    revision: z.string().trim().min(1),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("cancel"),
    reason: NullableStringSchema.optional().default(null),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("pause"),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("resume"),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("open_pull_request"),
    candidateId: z.string().trim().min(1),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("apply_candidate"),
    candidateId: z.string().trim().min(1),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("reject_candidate"),
    candidateId: z.string().trim().min(1),
    reason: NullableStringSchema.optional().default(null),
  }),
  z.object({
    ...CreateImproveActionBase,
    type: z.literal("reconcile_pull_request"),
    candidateId: z.string().trim().min(1),
  }),
]);

export const CreateImproveRunListResponseSchema = z.object({
  schemaVersion: z.literal("openpond.createImprove.runList.v1"),
  runs: z.array(CreateImproveRunSchema),
  generatedAt: z.string().trim().min(1),
});

export type CreateImproveSurface = z.infer<typeof CreateImproveSurfaceSchema>;
export type CreateImproveCommand = z.infer<typeof CreateImproveCommandSchema>;
export type CreateImproveOperation = z.infer<typeof CreateImproveOperationSchema>;
export type CreateImproveState = z.infer<typeof CreateImproveStateSchema>;
export type CreateImproveTarget = z.infer<typeof CreateImproveTargetSchema>;
export type CreateImproveTargetKind = z.infer<typeof CreateImproveTargetKindSchema>;
export type CreateImproveEvidenceSnapshot = z.infer<typeof CreateImproveEvidenceSnapshotSchema>;
export type CreateImproveTasksetRef = z.infer<typeof CreateImproveTasksetRefSchema>;
export type CreateImprovePlan = z.infer<typeof CreateImprovePlanSchema>;
export type CreateImproveActionShape = z.infer<typeof CreateImproveActionShapeSchema>;
export type CreateImproveQuestion = z.infer<typeof CreateImproveQuestionSchema>;
export type CreateImproveRequirement = z.infer<typeof CreateImproveRequirementSchema>;
export type CreateImproveWorkflowCapture = z.infer<typeof CreateImproveWorkflowCaptureSchema>;
export type CreateImprovePullRequest = z.infer<typeof CreateImprovePullRequestSchema>;
export type CreateImproveGitCandidate = z.infer<typeof CreateImproveGitCandidateSchema>;
export type CreateImproveCandidate = z.infer<typeof CreateImproveCandidateSchema>;
export type CreateImproveEvaluationReceipt = z.infer<typeof CreateImproveEvaluationReceiptSchema>;
export type CreateImproveRun = z.infer<typeof CreateImproveRunSchema>;
export type CreateImproveRunAction = z.infer<typeof CreateImproveRunActionSchema>;
export type CreateImproveRunListResponse = z.infer<typeof CreateImproveRunListResponseSchema>;

const CREATE_IMPROVE_TRANSITIONS: Record<CreateImproveState, ReadonlySet<CreateImproveState>> = {
  planning: new Set(["awaiting_questions", "awaiting_plan_approval", "blocked", "failed", "cancelled"]),
  awaiting_questions: new Set(["planning", "awaiting_plan_approval", "paused", "blocked", "failed", "cancelled"]),
  awaiting_plan_approval: new Set(["planning", "paused", "applying_source", "evaluating", "blocked", "failed", "cancelled"]),
  paused: new Set(["planning", "awaiting_questions", "awaiting_plan_approval", "applying_source", "running_checks", "evaluating", "blocked", "cancelled"]),
  applying_source: new Set(["running_checks", "ready_local", "blocked", "failed", "cancelled", "paused"]),
  running_checks: new Set(["evaluating", "ready", "ready_local", "blocked", "failed", "cancelled", "paused"]),
  evaluating: new Set(["awaiting_promotion", "ready", "ready_local", "blocked", "failed", "cancelled", "paused"]),
  awaiting_promotion: new Set(["opening_pull_request", "reconciling_release", "rejected", "blocked", "cancelled"]),
  opening_pull_request: new Set(["pull_request_open", "blocked", "failed", "cancelled"]),
  pull_request_open: new Set(["reconciling_release", "rejected", "blocked", "cancelled"]),
  reconciling_release: new Set(["pull_request_open", "released", "rejected", "blocked", "failed"]),
  released: new Set(["ready"]),
  rejected: new Set([]),
  ready: new Set(["planning", "evaluating", "awaiting_promotion", "pushing_hosted", "published_hosted", "blocked", "cancelled"]),
  ready_local: new Set(["pushing_hosted", "published_hosted", "blocked", "cancelled"]),
  pushing_hosted: new Set(["running_hosted_checks", "published_hosted", "blocked", "failed", "cancelled", "paused"]),
  running_hosted_checks: new Set(["published_hosted", "blocked", "failed", "cancelled", "paused"]),
  published_hosted: new Set([]),
  blocked: new Set([
    "planning",
    "awaiting_plan_approval",
    "applying_source",
    "evaluating",
    "reconciling_release",
    "cancelled",
  ]),
  failed: new Set(["planning", "evaluating", "cancelled"]),
  // A cancelled candidate is terminal, but an explicitly approved replacement
  // training job may reopen the canonical Model run with a new candidate.
  cancelled: new Set(["evaluating"]),
};

export function assertCreateImproveTransition(
  current: CreateImproveState,
  next: CreateImproveState,
): void {
  if (current === next) return;
  if (CREATE_IMPROVE_TRANSITIONS[current].has(next)) return;
  throw new Error(`Invalid Create/Improve transition: ${current} -> ${next}`);
}

export function nextCreateImproveRunRevision(
  run: CreateImproveRun,
  patch: Partial<Omit<CreateImproveRun, "schemaVersion" | "id" | "createdAt">>,
  actionId?: string | null,
): CreateImproveRun {
  const nextState = patch.state ?? run.state;
  assertCreateImproveTransition(run.state, nextState);
  const appliedActionIds = actionId
    ? [...run.appliedActionIds.filter((id) => id !== actionId), actionId].slice(-200)
    : run.appliedActionIds;
  return CreateImproveRunSchema.parse({
    ...run,
    ...patch,
    revision: run.revision + 1,
    appliedActionIds,
  });
}

export function inferCreateImproveActionShape(
  run: CreateImproveRun,
): CreateImproveActionShape {
  const metadataActionShape = createImproveActionShapeFromMetadata(run.metadata);
  const defaultActionKey = run.target.kind === "agent"
    ? run.target.defaultActionKey ?? "chat"
    : "chat";

  if (metadataActionShape) return metadataActionShape;

  return {
    mode: "chat",
    label: "Chat only",
    detail: "Expose the generated behavior through the default OpenPond chat action; no separate direct action is planned.",
    defaultActionKey,
    directActionHint: null,
    artifactPolicy: "Persist trace and run summary; declare output artifacts only if the generated chat action produces files.",
  };
}

export function createImproveActionShapeFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): CreateImproveActionShape | null {
  const parsed = CreateImproveActionShapeSchema.safeParse(metadata?.actionShape);
  return parsed.success ? parsed.data : null;
}
