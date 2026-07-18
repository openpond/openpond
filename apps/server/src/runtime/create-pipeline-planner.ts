import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostedChatMessage } from "@openpond/cloud";
import {
  CreateImproveActionShapeSchema,
  CreateImprovePlanSchema,
  CreateImproveQuestionSchema,
  CreateImproveRequirementSchema,
  CreateImproveWorkflowCaptureSchema,
  nextCreateImproveRunRevision,
  type ChatModelRef,
  type CreateImproveRun,
  type CreateImproveTarget,
} from "@openpond/contracts";

type PlannerStreamDelta = {
  text?: string;
  raw?: unknown;
  usage?: unknown;
};

export type ModelBackedCreateImprovePlannerInput = {
  run: CreateImproveRun;
  modelRef?: ChatModelRef | null;
  requestId: string;
  signal: AbortSignal;
  stream: (messages: HostedChatMessage[]) => AsyncGenerator<PlannerStreamDelta, void, unknown>;
};

export type CreateImprovePlannerInput = {
  run: CreateImproveRun;
  modelRef?: ChatModelRef | null;
  requestId: string;
  signal: AbortSignal;
};

export type CreateImprovePlanner = (
  input: CreateImprovePlannerInput,
) => Promise<CreateImproveRun>;

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
  targetId: z.string().trim().min(1).optional().nullable(),
  targetName: z.string().trim().min(1).optional().nullable(),
  agentId: z.string().trim().min(1).optional().nullable(),
  agentName: z.string().trim().min(1).optional().nullable(),
  summary: z.string().trim().min(1),
  capturedContextSummary: z.string().trim().min(1),
  actionShape: CreateImproveActionShapeSchema,
  defaultChatAction: z
    .object({
      key: z.string().trim().min(1).nullable().optional(),
      label: z.string().trim().min(1).nullable().optional(),
      required: z.boolean().default(true),
    })
    .optional()
    .nullable(),
  sourcePlan: z.array(PlannerSourcePlanItemSchema).default([]),
  requirements: z.array(CreateImproveRequirementSchema).default([]),
  checks: z.array(PlannerCheckSchema).default([]),
});

const PlannerDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    schemaVersion: z.literal("openpond.createImprove.plannerDecision.v1"),
    decision: z.literal("questions"),
    summary: z.string().trim().min(1).optional().nullable(),
    questions: z.array(PlannerQuestionSchema).min(1),
  }),
  z.object({
    schemaVersion: z.literal("openpond.createImprove.plannerDecision.v1"),
    decision: z.literal("plan"),
    plan: PlannerPlanDecisionSchema,
  }),
]);

type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;
type PlannerPlanDecision = z.infer<typeof PlannerPlanDecisionSchema>;

export async function runModelBackedCreateImprovePlanner(
  input: ModelBackedCreateImprovePlannerInput,
): Promise<CreateImproveRun> {
  const labDecision = labImprovePlanDecision(input.run);
  if (labDecision) {
    return createImproveRunFromPlannerDecision({
      run: input.run,
      decision: labDecision,
      modelRef: null,
    });
  }
  const messages = createImprovePlannerMessages(input.run);
  const content = await collectPlannerText(input.stream, messages);
  let decision: PlannerDecision;
  try {
    decision = parsePlannerDecision(content);
  } catch (error) {
    const repairMessages = createImprovePlannerRepairMessages({
      messages,
      invalidContent: content,
      error,
    });
    const repairedContent = await collectPlannerText(input.stream, repairMessages);
    try {
      decision = parsePlannerDecision(repairedContent);
    } catch (repairError) {
      throw new Error(
        `Create/Improve planner repair failed: ${plannerErrorSummary(repairError)}; initial error: ${plannerErrorSummary(error)}`,
      );
    }
  }
  return createImproveRunFromPlannerDecision({
    run: input.run,
    decision,
    modelRef: input.modelRef ?? null,
  });
}

async function collectPlannerText(
  stream: ModelBackedCreateImprovePlannerInput["stream"],
  messages: HostedChatMessage[],
): Promise<string> {
  let content = "";
  for await (const delta of stream(messages)) {
    if (delta.text) content += delta.text;
  }
  return content;
}

export function createImproveRunFromPlannerDecision(input: {
  run: CreateImproveRun;
  decision: PlannerDecision;
  modelRef?: ChatModelRef | null;
}): CreateImproveRun {
  if (input.decision.decision === "questions") {
    return createQuestionRun(input.run, input.decision, input.modelRef ?? null);
  }
  return createPlanRun(input.run, input.decision.plan, input.modelRef ?? null);
}

export function createBlockedCreateImprovePlannerRun(input: {
  run: CreateImproveRun;
  modelRef?: ChatModelRef | null;
  reason: string;
}): CreateImproveRun {
  const timestamp = new Date().toISOString();
  return nextCreateImproveRunRevision(input.run, {
    state: "blocked",
    plan: null,
    workflowCapture: workflowCaptureForRun(input.run),
    blockedReason: input.reason,
    metadata: {
      ...input.run.metadata,
      ...plannerProvenance(input.modelRef ?? null),
      plannerDecision: "blocked",
      plannerError: input.reason,
    },
    updatedAt: timestamp,
  });
}

function createQuestionRun(
  run: CreateImproveRun,
  decision: Extract<PlannerDecision, { decision: "questions" }>,
  modelRef: ChatModelRef | null,
): CreateImproveRun {
  const timestamp = new Date().toISOString();
  const questions = decision.questions.map((question, index) =>
    CreateImproveQuestionSchema.parse({
      id: question.id ?? `create_improve_question_${index + 1}`,
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
  return nextCreateImproveRunRevision(run, {
    state: "awaiting_questions",
    plan: null,
    workflowCapture: workflowCaptureForRun(run),
    approvalIds: [],
    questionIds: questions.map((question) => question.id),
    questions,
    blockedReason: null,
    metadata: {
      ...run.metadata,
      ...plannerProvenance(modelRef),
      plannerDecision: "questions",
      plannerSummary: decision.summary ?? null,
    },
    updatedAt: timestamp,
  });
}

function createPlanRun(
  run: CreateImproveRun,
  decision: PlannerPlanDecision,
  modelRef: ChatModelRef | null,
): CreateImproveRun {
  const timestamp = new Date().toISOString();
  const planId = `create_improve_plan_${randomUUID()}`;
  const approvalId = `approval_${randomUUID()}`;
  const target = plannedTarget(run.target, decision, run.objective);
  const sourceRoot = sourceRootForTarget(target);
  const actionShape = decision.actionShape;
  const checks = decision.checks.length ? decision.checks : defaultChecks(target.kind);
  const sourcePlan = decision.sourcePlan.length
    ? decision.sourcePlan
    : defaultSourcePlan({ run: { ...run, target }, sourceRoot });
  const defaultActionKey = decision.defaultChatAction?.key
    ?? actionShape.defaultActionKey
    ?? (target.kind === "agent" ? target.defaultActionKey : null)
    ?? "chat";
  const provenance = run.surface === "lab_improve"
    ? deterministicLabPlannerProvenance()
    : plannerProvenance(modelRef);
  const plan = CreateImprovePlanSchema.parse({
    schemaVersion: "openpond.createImprove.plan.v1",
    id: planId,
    runId: run.id,
    status: "pending_approval",
    objective: run.objective,
    summary: decision.summary,
    capturedContextSummary: decision.capturedContextSummary,
    defaultChatAction: {
      key: defaultActionKey,
      label: decision.defaultChatAction?.label ?? target.displayName ?? "Chat",
      required: decision.defaultChatAction?.required ?? true,
    },
    sourcePlan,
    requirements: decision.requirements,
    checks,
    approvalId,
    approvedAt: null,
    editedFromPlanId: null,
    metadata: {
      ...provenance,
      target,
      actionShape,
      actionShapeDecisionSource: run.surface === "lab_improve"
        ? "lab_improve_default_planner"
        : "model_planner",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const answeredQuestions = run.questions.map((question) =>
    question.status === "pending" ? { ...question, status: "skipped" as const } : question,
  );

  return nextCreateImproveRunRevision(run, {
    state: "awaiting_plan_approval",
    target,
    plan,
    workflowCapture: workflowCaptureForRun(run),
    approvalIds: [approvalId],
    questionIds: answeredQuestions.map((question) => question.id),
    questions: answeredQuestions,
    blockedReason: null,
    metadata: {
      ...run.metadata,
      ...provenance,
      plannerDecision: "plan",
    },
    updatedAt: timestamp,
  });
}

function plannedTarget(
  target: CreateImproveTarget,
  decision: PlannerPlanDecision,
  objective: string,
): CreateImproveTarget {
  const requestedId = decision.targetId ?? decision.agentId;
  const requestedName = decision.targetName ?? decision.agentName;
  if (target.kind !== "agent") {
    return {
      ...target,
      id: target.id ?? requestedId ?? null,
      displayName: target.displayName ?? requestedName ?? null,
    };
  }
  const id = normalizeTargetId(requestedId ?? "")
    || target.id
    || normalizeTargetId(requestedName ?? "")
    || targetIdFromObjective(objective);
  return {
    ...target,
    id,
    displayName: requestedName ?? target.displayName,
    defaultActionKey: target.defaultActionKey ?? `${id}.chat`,
  };
}

function workflowCaptureForRun(run: CreateImproveRun) {
  if (run.workflowCapture) return run.workflowCapture;
  const timestamp = new Date().toISOString();
  const outputArtifacts = uniqueNonEmpty(run.context.tools.flatMap((tool) => tool.artifactRefs));
  return CreateImproveWorkflowCaptureSchema.parse({
    schemaVersion: "openpond.createImprove.workflowCapture.v1",
    id: `workflow_capture_${randomUUID()}`,
    runId: run.id,
    command: run.command,
    objective: run.objective,
    conversationExcerpts: run.context.conversationExcerpts,
    attachments: run.context.attachments,
    apps: run.context.apps,
    tools: run.context.tools,
    sideEffects: uniqueNonEmpty(run.context.tools.flatMap((tool) => tool.sideEffects)),
    profileActions: uniqueNonEmpty(run.context.tools.map((tool) => tool.name)),
    externalProviders: uniqueNonEmpty([
      ...run.context.apps.map((app) => app.name),
      ...run.context.tools.map((tool) => providerNameFromTool(tool.name)),
    ]),
    environmentVariables: [],
    files: uniqueNonEmpty(
      run.context.attachments.map((attachment) =>
        attachment.ref ? `${attachment.name} (${attachment.ref})` : attachment.name,
      ),
    ),
    schedules: [],
    webhooks: [],
    channelTargets: ["openpond_chat"],
    outputArtifacts,
    targetRepoAssumptions: run.context.targetRepoAssumptions,
    traceRefs: outputArtifacts.filter((ref) => /\btrace\b|trace[:/-]/i.test(ref)),
    metadata: {
      source: "create_improve_model_planner",
      conversationId: run.scope.conversationId,
      workItemId: run.scope.workItemId,
      projectId: run.scope.projectId,
    },
    createdAt: timestamp,
  });
}

function defaultSourcePlan(input: { run: CreateImproveRun; sourceRoot: string }) {
  if (input.run.operation === "improve" && input.run.target.id) {
    return [
      {
        path: sourceRootForTarget(input.run.target),
        operation: "update" as const,
        reason: input.run.objective,
      },
      {
        path: "settings/profile.yaml",
        operation: "update" as const,
        reason: "Preserve the active Profile composition and routing.",
      },
    ];
  }
  return [
    {
      path: input.sourceRoot,
      operation: "create" as const,
      reason: input.run.objective,
    },
    {
      path: "settings/profile.yaml",
      operation: "update" as const,
      reason: "Register the workproduct in the active Profile.",
    },
  ];
}

function defaultChecks(kind: CreateImproveTarget["kind"]) {
  if (kind === "agent") {
    return [
      { name: "inspect", command: "pnpm agent:inspect", required: true },
      { name: "build", command: "pnpm build", required: true },
      { name: "validate", command: "pnpm agent:validate", required: true },
      { name: "eval", command: "pnpm agent:eval", required: true },
    ];
  }
  return [
    { name: "build", command: "pnpm build", required: true },
    { name: "validate", command: "pnpm run typecheck", required: true },
  ];
}

function sourceRootForTarget(target: CreateImproveTarget): string {
  const id = normalizeTargetId(target.id ?? target.displayName ?? "") || "draft";
  if (target.kind === "agent") return id === "default" ? "agent" : `agents/${id}`;
  if (target.kind === "skill") return `skills/${target.skillName ?? id}`;
  if (target.kind === "extension") return `extensions/${id}`;
  if (target.kind === "model") return `training/models/${id}`;
  if (target.kind === "unselected") return "profile";
  return `settings/${target.key ?? id}`;
}

function plannerProvenance(modelRef: ChatModelRef | null) {
  return {
    planner: {
      kind: "model",
      source: "create_improve_model_planner",
      providerId: modelRef?.providerId ?? null,
      modelId: modelRef?.modelId ?? null,
    },
  };
}

function deterministicLabPlannerProvenance() {
  return {
    planner: {
      kind: "deterministic",
      source: "lab_improve_default_planner",
      providerId: null,
      modelId: null,
    },
  };
}

function createImprovePlannerMessages(run: CreateImproveRun): HostedChatMessage[] {
  return [
    { role: "system", content: CREATE_IMPROVE_PLANNER_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify(
        {
          run,
          instruction:
            "Return only openpond.createImprove.plannerDecision.v1 JSON. Ask questions only when the user cannot approve a meaningful plan yet.",
        },
        null,
        2,
      ),
    },
  ];
}

function createImprovePlannerRepairMessages(input: {
  messages: HostedChatMessage[];
  invalidContent: string;
  error: unknown;
}): HostedChatMessage[] {
  return [
    ...input.messages,
    { role: "assistant", content: truncatePlannerContent(input.invalidContent) },
    {
      role: "user",
      content: [
        "The previous OpenPond Create/Improve planner decision failed schema validation.",
        "Return only one corrected openpond.createImprove.plannerDecision.v1 JSON object.",
        "Keep the same user intent and plan. Only change fields needed to satisfy the schema.",
        "plan.requirements is only for setup or dependency rows. Use [] when no setup is required.",
        'For questions use: {"schemaVersion":"openpond.createImprove.plannerDecision.v1","decision":"questions","questions":[{"kind":"free_text","title":"Short label","prompt":"Complete question?","required":true,"options":[]}]}',
        'For a plan use: {"schemaVersion":"openpond.createImprove.plannerDecision.v1","decision":"plan","plan":{...}}',
        "Do not wrap the JSON in Markdown or add prose.",
        `Validation error: ${plannerErrorSummary(input.error)}`,
      ].join("\n"),
    },
  ];
}

function parsePlannerDecision(content: string): PlannerDecision {
  const jsonText = extractJsonObject(content);
  if (!jsonText) throw new Error("Create/Improve planner returned no JSON decision.");
  try {
    return PlannerDecisionSchema.parse(normalizePlannerDecision(JSON.parse(jsonText)));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Create/Improve planner returned invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

function normalizePlannerDecision(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const decision = value.decision === "questions" || value.decision === "plan"
    ? value.decision
    : Array.isArray(value.questions)
      ? "questions"
      : isRecord(value.plan)
        ? "plan"
        : value.decision;
  const normalized: Record<string, unknown> = {
    ...value,
    schemaVersion: "openpond.createImprove.plannerDecision.v1",
    decision,
  };
  if (decision === "questions" && Array.isArray(value.questions)) {
    normalized.questions = value.questions.map(normalizePlannerQuestion);
  }
  return normalized;
}

function labImprovePlanDecision(run: CreateImproveRun): PlannerDecision | null {
  if (
    run.operation !== "improve"
    || run.surface !== "lab_improve"
  ) {
    return null;
  }
  const targetName = run.target.displayName ?? run.target.id ?? "Agent";
  const defaultActionKey = run.target.kind === "agent"
    ? run.target.defaultActionKey ?? `${run.target.id ?? "default"}.chat`
    : "chat";
  return PlannerDecisionSchema.parse({
    schemaVersion: "openpond.createImprove.plannerDecision.v1",
    decision: "plan",
    plan: {
      targetId: run.target.id,
      targetName,
      summary: `Improve ${targetName}: ${run.objective}`,
      capturedContextSummary:
        "The user supplied the desired outcome in Lab. Inspect the existing Profile source and choose the narrowest implementation that achieves it.",
      actionShape: {
        mode: "chat",
        label: "Chat",
        detail: "Preserve the Agent's existing chat surface while improving the requested behavior.",
        defaultActionKey,
        directActionHint: null,
        artifactPolicy: "Keep the source diff, checks, and evaluation evidence with the candidate for review.",
      },
      defaultChatAction: {
        key: defaultActionKey,
        label: targetName,
        required: true,
      },
      sourcePlan: [],
      requirements: [],
      checks: [],
    },
  });
}

function normalizePlannerQuestion(value: unknown, index: number): unknown {
  if (typeof value === "string") {
    const prompt = value.trim();
    return {
      kind: "free_text",
      title: plannerQuestionTitle(prompt, index),
      prompt,
      required: true,
      options: [],
    };
  }
  if (!isRecord(value)) return value;
  const options = Array.isArray(value.options)
    ? value.options.map(normalizePlannerQuestionOption)
    : [];
  const prompt = firstNonEmptyString(
    value.prompt,
    value.question,
    value.text,
    value.description,
    value.label,
    value.title,
  );
  const title = firstNonEmptyString(value.title, value.label)
    ?? (prompt ? plannerQuestionTitle(prompt, index) : null);
  return {
    ...value,
    kind: value.kind ?? (options.length ? "single_choice" : "free_text"),
    title,
    prompt,
    required: typeof value.required === "boolean" ? value.required : true,
    options,
  };
}

function normalizePlannerQuestionOption(value: unknown): unknown {
  if (typeof value === "string") {
    const label = value.trim();
    return { label, value: label };
  }
  if (!isRecord(value)) return value;
  const label = firstNonEmptyString(value.label, value.name, value.title, value.value);
  return {
    ...value,
    label,
    value: firstNonEmptyString(value.value, label),
  };
}

function plannerQuestionTitle(prompt: string, index: number): string {
  const normalized = prompt
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/g, "")
    .trim();
  if (!normalized) return `Question ${index + 1}`;
  return normalized.length <= 64 ? normalized : `${normalized.slice(0, 61).trimEnd()}...`;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function plannerErrorSummary(error: unknown): string {
  if (error instanceof z.ZodError) return JSON.stringify(error.issues);
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncatePlannerContent(content: string): string {
  const limit = 12_000;
  return content.length <= limit
    ? content
    : `${content.slice(0, limit)}\n... [truncated invalid planner output]`;
}

function normalizePlannerQuestionKind(value: unknown): unknown {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ([
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
  ].includes(normalized)) return "single_choice";
  if ([
    "free_text",
    "text",
    "freeform",
    "free_form",
    "open_text",
    "open_ended",
    "short_answer",
    "textarea",
    "string",
  ].includes(normalized)) return "free_text";
  return value;
}

function normalizePlannerSourcePlanOperation(value: unknown): unknown {
  if (value == null || value === "" || typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["create", "add", "author", "build", "generate", "implement", "init", "initialize", "materialize", "new", "scaffold", "write", "write_file"].includes(normalized)) return "create";
  if (["update", "change", "configure", "edit", "enable", "modify", "patch", "register", "replace", "revise", "set", "upsert"].includes(normalized)) return "update";
  if (["delete", "remove", "unlink"].includes(normalized)) return "delete";
  if (["inspect", "audit", "check", "discover", "read", "review", "validate", "verify"].includes(normalized)) return "inspect";
  return value;
}

function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : null;
}

function targetIdFromObjective(objective: string): string {
  return normalizeTargetId(
    objective
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "created-agent",
  );
}

function normalizeTargetId(value: string): string {
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
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

const CREATE_IMPROVE_PLANNER_SYSTEM_PROMPT = [
  "You are the OpenPond Create/Improve planner.",
  "Decide the user-facing plan before any Profile source or managed artifact is changed.",
  "Use the objective, target type, conversation context, attachments, selected Profile/project, tools, and prior answers.",
  "Do not rely on hidden keyword lists or hardcoded business examples.",
  "Return only JSON with schemaVersion openpond.createImprove.plannerDecision.v1.",
  "",
  "If the user cannot approve a meaningful plan yet, return questions.",
  "A plain-language desired outcome for an existing workproduct is actionable. Inspect its current source and choose implementation details yourself.",
  "Do not ask the user to choose tools, file paths, search strategies, or other implementation details.",
  "Ask a question only when user intent is missing or an irreversible product choice cannot be inferred safely.",
  "If the request is actionable, return a plan with targetId, targetName, summary, capturedContextSummary, actionShape, sourcePlan, requirements, and checks.",
  "requirements is only for setup and dependencies, never acceptance criteria or task bullets.",
  "Every sourcePlan operation must be create, update, delete, or inspect.",
  "Choose chat, direct_action, or chat_and_direct_actions from the actual behavior being created.",
].join("\n");
