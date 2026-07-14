import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostedChatMessage } from "@openpond/cloud";
import {
  CreatePipelineActionShapeSchema,
  CreatePipelinePlanSchema,
  CreatePipelineQuestionSchema,
  CreatePipelineRequirementSchema,
  CreatePipelineSnapshotSchema,
  WorkflowCaptureArtifactSchema,
  type ChatModelRef,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
} from "@openpond/contracts";

type PlannerStreamDelta = {
  text?: string;
  raw?: unknown;
  usage?: unknown;
};

export type ModelBackedCreatePipelinePlannerInput = {
  request: CreatePipelineRequest;
  previousSnapshot?: CreatePipelineSnapshot | null;
  modelRef?: ChatModelRef | null;
  requestId: string;
  signal: AbortSignal;
  stream: (messages: HostedChatMessage[]) => AsyncGenerator<PlannerStreamDelta, void, unknown>;
};

export type CreatePipelinePlannerInput = {
  request: CreatePipelineRequest;
  previousSnapshot?: CreatePipelineSnapshot | null;
  modelRef?: ChatModelRef | null;
  requestId: string;
  signal: AbortSignal;
};

export type CreatePipelinePlanner = (
  input: CreatePipelinePlannerInput,
) => Promise<CreatePipelineSnapshot>;

const PlannerQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1),
  value: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).nullable().optional(),
});

const PlannerQuestionSchema = z.object({
  id: z.string().trim().min(1).optional(),
  kind: z.preprocess(
    normalizePlannerQuestionKind,
    z.enum(["single_choice", "free_text"]).default("single_choice"),
  ),
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  required: z.boolean().default(true),
  options: z.array(PlannerQuestionOptionSchema).default([]),
});

const PlannerSourcePlanItemSchema = z.object({
  path: z.string().trim().min(1),
  operation: z.preprocess(
    normalizePlannerSourcePlanOperation,
    z.enum(["create", "update", "delete", "inspect"]),
  ),
  reason: z.string().trim().min(1),
});

const PlannerCheckSchema = z.object({
  name: z.string().trim().min(1),
  command: z.string().trim().min(1),
  required: z.boolean().default(true),
});

const PlannerPlanDecisionSchema = z.object({
  agentId: z.string().trim().min(1).optional().nullable(),
  agentName: z.string().trim().min(1).optional().nullable(),
  summary: z.string().trim().min(1),
  capturedContextSummary: z.string().trim().min(1),
  actionShape: CreatePipelineActionShapeSchema,
  defaultChatAction: z
    .object({
      key: z.string().trim().min(1).nullable().optional(),
      label: z.string().trim().min(1).nullable().optional(),
      required: z.boolean().default(true),
    })
    .optional()
    .nullable(),
  sourcePlan: z.array(PlannerSourcePlanItemSchema).default([]),
  requirements: z.array(CreatePipelineRequirementSchema).default([]),
  checks: z.array(PlannerCheckSchema).default([]),
});

const PlannerDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    schemaVersion: z.literal("openpond.createPipeline.plannerDecision.v1"),
    decision: z.literal("questions"),
    summary: z.string().trim().min(1).optional().nullable(),
    questions: z.array(PlannerQuestionSchema).min(1),
  }),
  z.object({
    schemaVersion: z.literal("openpond.createPipeline.plannerDecision.v1"),
    decision: z.literal("plan"),
    plan: PlannerPlanDecisionSchema,
  }),
]);

type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;
type PlannerPlanDecision = z.infer<typeof PlannerPlanDecisionSchema>;

export async function runModelBackedCreatePipelinePlanner(
  input: ModelBackedCreatePipelinePlannerInput,
): Promise<CreatePipelineSnapshot> {
  const messages = createPipelinePlannerMessages({
    request: input.request,
    previousSnapshot: input.previousSnapshot ?? null,
  });
  const content = await collectPlannerText(input.stream, messages);
  let decision: PlannerDecision;
  try {
    decision = parsePlannerDecision(content);
  } catch (error) {
    const repairMessages = createPipelinePlannerRepairMessages({
      messages,
      invalidContent: content,
      error,
    });
    const repairedContent = await collectPlannerText(input.stream, repairMessages);
    try {
      decision = parsePlannerDecision(repairedContent);
    } catch (repairError) {
      throw new Error(
        `Create planner repair failed: ${plannerErrorSummary(repairError)}; initial error: ${plannerErrorSummary(error)}`,
      );
    }
  }
  return createPipelineSnapshotFromPlannerDecision({
    request: input.request,
    previousSnapshot: input.previousSnapshot ?? null,
    decision,
    modelRef: input.modelRef ?? null,
  });
}

async function collectPlannerText(
  stream: ModelBackedCreatePipelinePlannerInput["stream"],
  messages: HostedChatMessage[],
): Promise<string> {
  let content = "";
  for await (const delta of stream(messages)) {
    if (delta.text) content += delta.text;
  }
  return content;
}

export function createPipelineSnapshotFromPlannerDecision(input: {
  request: CreatePipelineRequest;
  previousSnapshot?: CreatePipelineSnapshot | null;
  decision: PlannerDecision;
  modelRef?: ChatModelRef | null;
}): CreatePipelineSnapshot {
  if (input.decision.decision === "questions") {
    return createQuestionSnapshot({
      request: input.request,
      previousSnapshot: input.previousSnapshot ?? null,
      decision: input.decision,
      modelRef: input.modelRef ?? null,
    });
  }
  return createPlanSnapshot({
    request: input.request,
    previousSnapshot: input.previousSnapshot ?? null,
    planDecision: input.decision.plan,
    modelRef: input.modelRef ?? null,
  });
}

export function createBlockedCreatePipelinePlannerSnapshot(input: {
  request: CreatePipelineRequest;
  previousSnapshot?: CreatePipelineSnapshot | null;
  modelRef?: ChatModelRef | null;
  reason: string;
}): CreatePipelineSnapshot {
  const now = new Date().toISOString();
  const previousSnapshot = input.previousSnapshot ?? null;
  return CreatePipelineSnapshotSchema.parse({
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id: previousSnapshot?.id ?? `create_pipeline_${randomUUID()}`,
    goalId: input.request.scope.workItemId ?? input.request.id,
    state: "blocked",
    request: input.request,
    plan: null,
    workflowCapture: workflowCaptureForRequest(input.request, previousSnapshot),
    approvalIds: [],
    questionIds: previousSnapshot?.questionIds ?? [],
    questions: previousSnapshot?.questions ?? [],
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: input.request.adapter.kind === "local" ? input.request.adapter.localHead : null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: input.request.adapter.kind === "hosted" ? input.request.adapter.sourceRef : null,
    blockedReason: input.reason,
    metadata: {
      ...plannerProvenance(input.modelRef ?? null),
      plannerDecision: "blocked",
      plannerError: input.reason,
    },
    createdAt: previousSnapshot?.createdAt ?? now,
    updatedAt: now,
  });
}

function createQuestionSnapshot(input: {
  request: CreatePipelineRequest;
  previousSnapshot?: CreatePipelineSnapshot | null;
  decision: Extract<PlannerDecision, { decision: "questions" }>;
  modelRef?: ChatModelRef | null;
}): CreatePipelineSnapshot {
  const now = new Date().toISOString();
  const snapshotId = input.previousSnapshot?.id ?? `create_pipeline_${randomUUID()}`;
  const questions = input.decision.questions.map((question, index) =>
    CreatePipelineQuestionSchema.parse({
      id: question.id ?? `create_question_${index + 1}`,
      kind: question.kind,
      title: question.title,
      prompt: question.prompt,
      required: question.required,
      status: "pending",
      options: question.options.map((option, optionIndex) => ({
        id: option.id ?? `option_${optionIndex + 1}`,
        label: option.label,
        value: option.value ?? option.label,
        description: option.description ?? null,
        metadata: {},
      })),
      answer: null,
      metadata: {},
    }),
  );
  return CreatePipelineSnapshotSchema.parse({
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id: snapshotId,
    goalId: input.request.scope.workItemId ?? input.request.id,
    state: "awaiting_questions",
    request: input.request,
    plan: null,
    workflowCapture: workflowCaptureForRequest(input.request, input.previousSnapshot),
    approvalIds: [],
    questionIds: questions.map((question) => question.id),
    questions,
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: input.request.adapter.kind === "local" ? input.request.adapter.localHead : null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: input.request.adapter.kind === "hosted" ? input.request.adapter.sourceRef : null,
    blockedReason: null,
    metadata: {
      ...plannerProvenance(input.modelRef ?? null),
      plannerDecision: "questions",
      plannerSummary: input.decision.summary ?? null,
    },
    createdAt: input.previousSnapshot?.createdAt ?? now,
    updatedAt: now,
  });
}

function createPlanSnapshot(input: {
  request: CreatePipelineRequest;
  previousSnapshot?: CreatePipelineSnapshot | null;
  planDecision: PlannerPlanDecision;
  modelRef?: ChatModelRef | null;
}): CreatePipelineSnapshot {
  const now = new Date().toISOString();
  const snapshotId = input.previousSnapshot?.id ?? `create_pipeline_${randomUUID()}`;
  const planId = `create_plan_${randomUUID()}`;
  const approvalId = `approval_${randomUUID()}`;
  const agentId =
    normalizeAgentId(input.planDecision.agentId ?? "") ||
    input.request.targetAgent.agentId ||
    normalizeAgentId(input.planDecision.agentName ?? "") ||
    agentIdFromObjective(input.request.objective);
  const sourceRoot = createPipelineSourceRootPathForAgent(agentId);
  const actionShape = input.planDecision.actionShape;
  const checks = input.planDecision.checks.length
    ? input.planDecision.checks
    : defaultChecks();
  const sourcePlan = input.planDecision.sourcePlan.length
    ? input.planDecision.sourcePlan
    : defaultSourcePlan({
        request: input.request,
        sourceRoot,
      });
  const defaultActionKey =
    input.planDecision.defaultChatAction?.key ??
    actionShape.defaultActionKey ??
    input.request.targetAgent.defaultActionKey ??
    "chat";
  const plan = CreatePipelinePlanSchema.parse({
    schemaVersion: "openpond.createPipeline.plan.v1",
    id: planId,
    goalId: input.request.scope.workItemId ?? input.request.id,
    requestId: input.request.id,
    status: "pending_approval",
    objective: input.request.objective,
    summary: input.planDecision.summary,
    capturedContextSummary: input.planDecision.capturedContextSummary,
    defaultChatAction: {
      key: defaultActionKey,
      label:
        input.planDecision.defaultChatAction?.label ??
        input.planDecision.agentName ??
        input.request.targetAgent.displayName ??
        "Chat",
      required: input.planDecision.defaultChatAction?.required ?? true,
    },
    sourcePlan,
    requirements: input.planDecision.requirements,
    checks,
    approvalId,
    approvedAt: null,
    editedFromPlanId: null,
    metadata: {
      ...plannerProvenance(input.modelRef ?? null),
      agentId,
      agentName: input.planDecision.agentName ?? null,
      actionShape,
      actionShapeDecisionSource: "model_planner",
    },
    createdAt: now,
    updatedAt: now,
  });

  const answeredQuestions = (input.previousSnapshot?.questions ?? []).map((question) =>
    question.status === "pending"
      ? {
          ...question,
          status: "skipped" as const,
        }
      : question,
  );

  return CreatePipelineSnapshotSchema.parse({
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id: snapshotId,
    goalId: input.request.scope.workItemId ?? input.request.id,
    state: "awaiting_plan_approval",
    request: input.request,
    plan,
    workflowCapture: workflowCaptureForRequest(input.request, input.previousSnapshot),
    approvalIds: [approvalId],
    questionIds: answeredQuestions.map((question) => question.id),
    questions: answeredQuestions,
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: input.request.adapter.kind === "local" ? input.request.adapter.localHead : null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: input.request.adapter.kind === "hosted" ? input.request.adapter.sourceRef : null,
    blockedReason: null,
    metadata: {
      ...plannerProvenance(input.modelRef ?? null),
      plannerDecision: "plan",
    },
    createdAt: input.previousSnapshot?.createdAt ?? now,
    updatedAt: now,
  });
}

function workflowCaptureForRequest(
  request: CreatePipelineRequest,
  previousSnapshot?: CreatePipelineSnapshot | null,
) {
  if (previousSnapshot?.workflowCapture) return previousSnapshot.workflowCapture;
  const now = new Date().toISOString();
  const outputArtifacts = uniqueNonEmpty(
    request.context.tools.flatMap((tool) => tool.artifactRefs),
  );
  return WorkflowCaptureArtifactSchema.parse({
    schemaVersion: "openpond.createPipeline.workflowCapture.v1",
    id: `workflow_capture_${randomUUID()}`,
    goalId: request.scope.workItemId ?? request.id,
    requestId: request.id,
    command: request.command,
    objective: request.objective,
    conversationExcerpts: request.context.conversationExcerpts,
    attachments: request.context.attachments,
    apps: request.context.apps,
    tools: request.context.tools,
    sideEffects: uniqueNonEmpty(request.context.tools.flatMap((tool) => tool.sideEffects)),
    profileActions: uniqueNonEmpty(request.context.tools.map((tool) => tool.name)),
    externalProviders: uniqueNonEmpty([
      ...request.context.apps.map((app) => app.name),
      ...request.context.tools.map((tool) => providerNameFromTool(tool.name)),
    ]),
    environmentVariables: [],
    files: uniqueNonEmpty(
      request.context.attachments.map((attachment) =>
        attachment.ref ? `${attachment.name} (${attachment.ref})` : attachment.name,
      ),
    ),
    schedules: [],
    webhooks: [],
    channelTargets: ["openpond_chat"],
    outputArtifacts,
    targetRepoAssumptions: request.context.targetRepoAssumptions,
    traceRefs: outputArtifacts.filter((ref) => /\btrace\b|trace[:/-]/i.test(ref)),
    metadata: {
      source: "create_pipeline_model_planner",
      conversationId: request.scope.conversationId,
      workItemId: request.scope.workItemId,
      projectId: request.scope.projectId,
    },
    createdAt: now,
  });
}

function defaultSourcePlan(input: {
  request: CreatePipelineRequest;
  sourceRoot: string;
}) {
  if (input.request.operation === "edit" && input.request.targetAgent.agentId) {
    return [
      {
        path: createPipelineSourceRootPathForAgent(input.request.targetAgent.agentId),
        operation: "update" as const,
        reason: input.request.objective,
      },
      {
        path: "settings/profile.yaml",
        operation: "update" as const,
        reason: "Preserve the default chat action and profile catalog routing.",
      },
    ];
  }
  return [
    {
      path: input.sourceRoot,
      operation: "create" as const,
      reason: input.request.objective,
    },
    {
      path: "settings/profile.yaml",
      operation: "update" as const,
      reason: "Register the generated agent and expose it through the profile catalog.",
    },
  ];
}

function defaultChecks() {
  return [
    { name: "inspect", command: "bun run agent:inspect", required: true },
    { name: "build", command: "bun run build", required: true },
    { name: "validate", command: "bun run agent:validate", required: true },
    { name: "eval", command: "bun run agent:eval", required: true },
  ];
}

function plannerProvenance(modelRef: ChatModelRef | null) {
  return {
    planner: {
      kind: "model",
      source: "create_pipeline_model_planner",
      providerId: modelRef?.providerId ?? null,
      modelId: modelRef?.modelId ?? null,
    },
  };
}

function createPipelinePlannerMessages(input: {
  request: CreatePipelineRequest;
  previousSnapshot: CreatePipelineSnapshot | null;
}): HostedChatMessage[] {
  return [
    {
      role: "system",
      content: CREATE_PIPELINE_PLANNER_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          request: input.request,
          previousQuestions: input.previousSnapshot?.questions ?? [],
          instruction:
            "Return only openpond.createPipeline.plannerDecision.v1 JSON. Ask questions only when the user cannot approve a meaningful plan yet.",
        },
        null,
        2,
      ),
    },
  ];
}

function createPipelinePlannerRepairMessages(input: {
  messages: HostedChatMessage[];
  invalidContent: string;
  error: unknown;
}): HostedChatMessage[] {
  return [
    ...input.messages,
    {
      role: "assistant",
      content: truncatePlannerContent(input.invalidContent),
    },
    {
      role: "user",
      content: [
        "The previous OpenPond Create planner decision failed schema validation.",
        "Return only one corrected openpond.createPipeline.plannerDecision.v1 JSON object.",
        "Keep the same user intent and plan. Only change fields needed to satisfy the schema.",
        "Important: plan.requirements is only for setup/dependency rows. Use [] when no setup is required.",
        "Never put feature requirements, acceptance criteria, user goals, or task bullets in plan.requirements.",
        'Each plan.requirements item must be an object like {"kind":"integration","name":"GitHub","status":"required","detail":"Connection required before publish.","metadata":{}}.',
        `Validation error: ${plannerErrorSummary(input.error)}`,
      ].join("\n"),
    },
  ];
}

function parsePlannerDecision(content: string): PlannerDecision {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    throw new Error("Create planner returned no JSON decision.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Create planner returned invalid JSON: ${message}`);
  }
  return PlannerDecisionSchema.parse(payload);
}

function plannerErrorSummary(error: unknown): string {
  if (error instanceof z.ZodError) return JSON.stringify(error.issues);
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncatePlannerContent(content: string): string {
  const limit = 12000;
  if (content.length <= limit) return content;
  return `${content.slice(0, limit)}\n... [truncated invalid planner output]`;
}

function normalizePlannerQuestionKind(value: unknown): unknown {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    [
      "single_choice",
      "single_select",
      "single",
      "choice",
      "select",
      "select_one",
      "radio",
      "dropdown",
      "multiple_choice",
      "multi_choice",
      "multi_select",
      "multiple_select",
      "checkbox",
      "checkboxes",
    ].includes(normalized)
  ) {
    return "single_choice";
  }
  if (
    [
      "free_text",
      "text",
      "freeform",
      "free_form",
      "open_text",
      "open_ended",
      "short_answer",
      "textarea",
      "string",
    ].includes(normalized)
  ) {
    return "free_text";
  }
  return value;
}

function normalizePlannerSourcePlanOperation(value: unknown): unknown {
  if (value == null || value === "") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    [
      "create",
      "add",
      "author",
      "build",
      "generate",
      "implement",
      "init",
      "initialize",
      "materialize",
      "new",
      "scaffold",
      "write",
      "write_file",
    ].includes(normalized)
  ) {
    return "create";
  }
  if (
    [
      "update",
      "change",
      "configure",
      "edit",
      "enable",
      "modify",
      "patch",
      "register",
      "replace",
      "revise",
      "set",
      "upsert",
    ].includes(normalized)
  ) {
    return "update";
  }
  if (["delete", "remove", "unlink"].includes(normalized)) {
    return "delete";
  }
  if (
    [
      "inspect",
      "audit",
      "check",
      "discover",
      "read",
      "review",
      "validate",
      "verify",
    ].includes(normalized)
  ) {
    return "inspect";
  }
  return value;
}

function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function agentIdFromObjective(objective: string): string {
  return normalizeAgentId(
    objective
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "created-agent",
  );
}

function createPipelineSourceRootPathForAgent(agentId: string): string {
  return agentId === "default" ? "agent" : `agents/${agentId}`;
}

function normalizeAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function providerNameFromTool(name: string): string {
  const [provider] = name.split(".");
  return provider?.trim() || name;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)),
  );
}

const CREATE_PIPELINE_PLANNER_SYSTEM_PROMPT = [
  "You are the OpenPond Create planner.",
  "Your job is to decide the user-facing plan before any profile source is mutated.",
  "Use the short user request, chat context, attachments, selected profile/project context, catalog/tool context, and prior answers.",
  "Do not rely on hidden keyword lists or hardcoded business examples.",
  "Return only JSON with schemaVersion openpond.createPipeline.plannerDecision.v1.",
  "",
  "If the request is ambiguous and the user cannot approve a meaningful plan yet, return:",
  '{"schemaVersion":"openpond.createPipeline.plannerDecision.v1","decision":"questions","questions":[{"title":"Data source","prompt":"Where should this agent read from?","kind":"single_choice","required":true,"options":[{"label":"Committed local fixtures","value":"fixtures"},{"label":"Existing local file","value":"local_file"}]}]}',
  "",
  "If the request is actionable, return:",
  '{"schemaVersion":"openpond.createPipeline.plannerDecision.v1","decision":"plan","plan":{"agentId":"short-agent-id","agentName":"Short Agent Name","summary":"What will be created.","capturedContextSummary":"What context will be used.","actionShape":{"mode":"chat","label":"Chat only","detail":"Expose through default chat.","defaultActionKey":"chat","directActionHint":null,"artifactPolicy":"Persist trace and run summary."},"defaultChatAction":{"key":"chat","label":"Chat","required":true},"sourcePlan":[{"path":"agents/short-agent-id","operation":"create","reason":"Implement the approved agent."}],"requirements":[],"checks":[{"name":"inspect","command":"bun run agent:inspect","required":true},{"name":"build","command":"bun run build","required":true},{"name":"validate","command":"bun run agent:validate","required":true},{"name":"eval","command":"bun run agent:eval","required":true}]}}',
  "",
  "plan.requirements is only for setup/dependency rows, never feature requirements, acceptance criteria, user goals, or task bullets.",
  "For self-contained demos, committed fixtures, mock CSV files, and normal chat behavior, use requirements: [] unless actual setup is needed.",
  'Never emit strings in plan.requirements. Each item must be an object like {"kind":"integration","name":"GitHub","status":"required","detail":"Connection required before publish.","metadata":{}}.',
  "Valid requirement kinds are npm_package, runtime_tool, setup_command, secret, integration, volume, target_project, and external_service.",
  "Put functional details such as chat endpoints, mock data files, exports, and demo behavior in summary, capturedContextSummary, actionShape.detail, and sourcePlan reasons.",
  "",
  "Choose actionShape.mode as chat, direct_action, or chat_and_direct_actions from the user's actual need.",
  "Use direct actions for repeatable tool-like runs, artifacts, exports, transforms, or scheduled-style outputs.",
  "Use chat for conversational assistants. Use chat_and_direct_actions when both normal follow-up chat and a repeatable action are useful.",
  "Every sourcePlan item operation must be exactly one of create, update, delete, or inspect.",
].join("\n");
