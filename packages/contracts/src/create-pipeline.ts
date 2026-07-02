import { z } from "zod";

const NullableStringSchema = z.string().trim().min(1).nullable();
const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const CreatePipelineSurfaceSchema = z.enum([
  "direct_prompt_create",
  "context_backed_create",
  "create_as_agent",
  "workflow_suggestion",
  "local_extend",
  "hosted_create",
  "local_import",
  "direct_prompt_edit",
  "context_backed_edit",
  "hosted_edit",
]);

export const CreatePipelineCommandSchema = z.enum([
  "/create",
  "/edit",
  "openpond extend",
  "create_as_agent",
  "suggest_workflow",
  "local_import",
  "hosted_create",
  "hosted_edit",
]);

export const CreatePipelineOperationSchema = z.enum([
  "create",
  "edit",
  "import",
  "promote",
]);

export const CreatePipelineStateSchema = z.enum([
  "planning",
  "awaiting_questions",
  "awaiting_plan_approval",
  "applying_source",
  "running_checks",
  "ready_local",
  "pushing_hosted",
  "running_hosted_checks",
  "published_hosted",
  "blocked",
  "failed",
  "cancelled",
]);

export const CreatePipelineConfirmationPolicySchema = z.enum([
  "always_require_plan_approval",
  "approval_already_granted",
]);

export const CreatePipelineSourceAuthoritySchema = z.enum([
  "local_profile",
  "hosted_profile",
  "promote_local_to_hosted",
]);

export const CreatePipelineExecutionAdapterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    sourceAuthority: z.literal("local_profile"),
    activeProfile: z.string().trim().min(1).nullable(),
    repoPath: NullableStringSchema,
    sourcePath: NullableStringSchema,
    localHead: NullableStringSchema,
    confirmationPolicy: CreatePipelineConfirmationPolicySchema.default(
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
    confirmationPolicy: CreatePipelineConfirmationPolicySchema.default(
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
    confirmationPolicy: CreatePipelineConfirmationPolicySchema.default(
      "always_require_plan_approval",
    ),
  }),
]);

export const CreatePipelineActorSchema = z.object({
  id: NullableStringSchema,
  kind: z.enum(["user", "system", "automation"]).default("user"),
  label: NullableStringSchema,
});

export const CreatePipelineScopeSchema = z.object({
  conversationId: NullableStringSchema,
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

export const CreatePipelineContextSchema = z.object({
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
  targetRepoAssumptions: z.array(z.string().trim().min(1)).default([]),
});

export const CreatePipelineTargetAgentSchema = z.object({
  agentId: NullableStringSchema,
  displayName: NullableStringSchema,
  defaultActionKey: NullableStringSchema,
});

export const CreatePipelineRequestSchema = z.object({
  schemaVersion: z.literal("openpond.createPipeline.request.v1"),
  id: z.string().trim().min(1),
  operation: CreatePipelineOperationSchema,
  surface: CreatePipelineSurfaceSchema,
  command: CreatePipelineCommandSchema,
  objective: z.string().trim().min(1),
  adapter: CreatePipelineExecutionAdapterSchema,
  actor: CreatePipelineActorSchema,
  scope: CreatePipelineScopeSchema,
  context: CreatePipelineContextSchema,
  targetAgent: CreatePipelineTargetAgentSchema,
  metadata: MetadataSchema,
  createdAt: z.string().trim().min(1),
});

export const CreatePipelineRequirementSchema = z.object({
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

export const CreatePipelineActionShapeSchema = z.object({
  mode: z.enum(["chat", "direct_action", "chat_and_direct_actions"]),
  label: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  defaultActionKey: NullableStringSchema,
  directActionHint: NullableStringSchema,
  artifactPolicy: z.string().trim().min(1),
});

export const CreatePipelinePlanSchema = z.object({
  schemaVersion: z.literal("openpond.createPipeline.plan.v1"),
  id: z.string().trim().min(1),
  goalId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
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
  requirements: z.array(CreatePipelineRequirementSchema).default([]),
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

export const CreatePipelineQuestionOptionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  value: z.string().trim().min(1),
  description: NullableStringSchema,
  metadata: MetadataSchema,
});

export const CreatePipelineQuestionAnswerSchema = z.object({
  value: z.string().trim().min(1),
  label: NullableStringSchema,
  detail: NullableStringSchema,
  answeredAt: z.string().trim().min(1),
  metadata: MetadataSchema,
});

export const CreatePipelineQuestionSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(["single_choice", "free_text"]).default("single_choice"),
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  required: z.boolean().default(true),
  status: z.enum(["pending", "answered", "skipped"]).default("pending"),
  options: z.array(CreatePipelineQuestionOptionSchema).default([]),
  answer: CreatePipelineQuestionAnswerSchema.nullable().default(null),
  metadata: MetadataSchema,
});

export const WorkflowCaptureArtifactSchema = z.object({
  schemaVersion: z.literal("openpond.createPipeline.workflowCapture.v1"),
  id: z.string().trim().min(1),
  goalId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  command: CreatePipelineCommandSchema,
  objective: z.string().trim().min(1),
  conversationExcerpts: CreatePipelineContextSchema.shape.conversationExcerpts,
  attachments: CreatePipelineContextSchema.shape.attachments,
  apps: CreatePipelineContextSchema.shape.apps,
  tools: CreatePipelineContextSchema.shape.tools,
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

export const CreatePipelineSnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.createPipeline.snapshot.v1"),
  id: z.string().trim().min(1),
  goalId: z.string().trim().min(1),
  state: CreatePipelineStateSchema,
  request: CreatePipelineRequestSchema,
  plan: CreatePipelinePlanSchema.nullable(),
  workflowCapture: WorkflowCaptureArtifactSchema.nullable(),
  approvalIds: z.array(z.string().trim().min(1)).default([]),
  questionIds: z.array(z.string().trim().min(1)).default([]),
  questions: z.array(CreatePipelineQuestionSchema).default([]),
  checkRefs: z.array(z.string().trim().min(1)).default([]),
  sourceRefs: z.array(z.string().trim().min(1)).default([]),
  localGoalId: NullableStringSchema,
  localProfileCommit: NullableStringSchema,
  hostedGoalId: NullableStringSchema,
  hostedSourceCommit: NullableStringSchema,
  hostedSourceRef: NullableStringSchema,
  blockedReason: NullableStringSchema,
  metadata: MetadataSchema,
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

export type CreatePipelineSurface = z.infer<typeof CreatePipelineSurfaceSchema>;
export type CreatePipelineCommand = z.infer<typeof CreatePipelineCommandSchema>;
export type CreatePipelineOperation = z.infer<typeof CreatePipelineOperationSchema>;
export type CreatePipelineState = z.infer<typeof CreatePipelineStateSchema>;
export type CreatePipelineRequest = z.infer<typeof CreatePipelineRequestSchema>;
export type CreatePipelinePlan = z.infer<typeof CreatePipelinePlanSchema>;
export type CreatePipelineActionShape = z.infer<typeof CreatePipelineActionShapeSchema>;
export type CreatePipelineQuestion = z.infer<typeof CreatePipelineQuestionSchema>;
export type CreatePipelineRequirement = z.infer<typeof CreatePipelineRequirementSchema>;
export type WorkflowCaptureArtifact = z.infer<typeof WorkflowCaptureArtifactSchema>;
export type CreatePipelineSnapshot = z.infer<typeof CreatePipelineSnapshotSchema>;

export function inferCreatePipelineActionShape(
  request: CreatePipelineRequest,
): CreatePipelineActionShape {
  const metadataActionShape = createPipelineActionShapeFromMetadata(request.metadata);
  const defaultActionKey = request.targetAgent.defaultActionKey ?? "chat";

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

export function createPipelineActionShapeFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): CreatePipelineActionShape | null {
  const parsed = CreatePipelineActionShapeSchema.safeParse(metadata?.actionShape);
  return parsed.success ? parsed.data : null;
}
