import {
  CreatePipelineRequestSchema,
  CreatePipelineSnapshotSchema,
  type BootstrapPayload,
  type ChatAttachment,
  type CloudProject,
  type CloudWorkItem,
  type CreatePipelineCommand,
  type CreatePipelineQuestion,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type CreatePipelineSurface,
  type OpenPondApp,
  type Session,
  createPipelineActionShapeFromMetadata,
  inferCreatePipelineActionShape,
} from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import type { ParsedComposerSlashCommand } from "./composer-slash-commands";

const MAX_CAPTURED_CHAT_EXCERPTS = 6;
const MAX_CAPTURED_CHAT_EXCERPT_CHARS = 1200;

export function buildComposerCreatePipelineRequest(input: {
  parsed: ParsedComposerSlashCommand;
  prompt: string;
  payload: BootstrapPayload | null;
  session: Session | null;
  messages?: ChatMessage[];
  attachments?: ChatAttachment[];
  apps?: OpenPondApp[];
}): CreatePipelineRequest | null {
  if (input.parsed.command !== "create" && input.parsed.command !== "edit") {
    return null;
  }
  const objective = input.parsed.args || input.prompt.trim();
  if (!objective) return null;
  const now = new Date().toISOString();
  const profile = input.payload?.profile ?? null;
  const localProfileLoaded = profile?.mode === "local";
  const command: CreatePipelineCommand =
    input.parsed.command === "create" ? "/create" : "/edit";
  const conversationExcerpts = capturedConversationExcerpts(input.messages ?? []);
  const hasCapturedConversation = conversationExcerpts.length > 0;
  const surface: CreatePipelineSurface =
    input.parsed.command === "create"
      ? hasCapturedConversation
        ? "context_backed_create"
        : "direct_prompt_create"
      : hasCapturedConversation
        ? "context_backed_edit"
        : "direct_prompt_edit";
  const targetAgentId =
    input.parsed.command === "edit" ? input.session?.appId ?? null : null;
  if (input.parsed.command === "edit" && !targetAgentId) {
    return null;
  }
  const apps = capturedApps(input.apps ?? [], input.session);
  return CreatePipelineRequestSchema.parse({
    schemaVersion: "openpond.createPipeline.request.v1",
    id: `create_request_${crypto.randomUUID()}`,
    operation: input.parsed.command === "create" ? "create" : "edit",
    surface,
    command,
    objective,
    adapter: localProfileLoaded
      ? {
          kind: "local",
          sourceAuthority: "local_profile",
          activeProfile: profile.activeProfile,
          repoPath: profile.repoPath,
          sourcePath: profile.sourcePath,
          localHead: profile.git?.head ?? null,
          confirmationPolicy: "always_require_plan_approval",
        }
      : {
          kind: "hosted",
          sourceAuthority: "hosted_profile",
          teamId:
            input.session?.cloudTeamId ??
            input.payload?.preferences.defaultTeamId ??
            null,
          projectId: input.session?.cloudProjectId ?? null,
          activeProfile: profile?.activeProfile ?? "default",
          sourceRef: profile?.hosted?.sourceRef ?? null,
          baseSha: profile?.hosted?.sourceCommitSha ?? null,
          workItemId: null,
          confirmationPolicy: "always_require_plan_approval",
        },
    actor: {
      id: input.payload?.account.activeProfile?.handle ?? null,
      kind: "user",
      label: input.payload?.account.label ?? null,
    },
    scope: {
      conversationId: input.session?.id ?? null,
      workItemId: null,
      projectId: input.session?.cloudProjectId ?? input.session?.localProjectId ?? null,
      targetProject: input.session?.workspaceId
        ? {
            id: input.session.workspaceId,
            name: input.session.workspaceName,
            workspacePath: input.session.cwd,
            sourceRef: null,
            baseSha: null,
          }
        : null,
    },
    context: {
      messageIds: conversationExcerpts.map((excerpt) => excerpt.messageId).filter((id): id is string => Boolean(id)),
      conversationExcerpts,
      attachments: capturedAttachments(input.attachments ?? []),
      apps,
      tools: capturedTools(input.messages ?? []),
      targetRepoAssumptions: input.session?.cwd ? [`workspace: ${input.session.cwd}`] : [],
    },
    targetAgent: {
      agentId: targetAgentId,
      displayName: input.parsed.command === "edit" ? input.session?.appName ?? null : null,
      defaultActionKey: targetAgentId ? `${targetAgentId}.chat` : "chat",
    },
    metadata: {
      source: "web_composer_slash",
      selectedCommand: command,
      capturedMessageCount: conversationExcerpts.length,
    },
    createdAt: now,
  });
}

function capturedApps(apps: OpenPondApp[], session: Session | null) {
  const byId = new Map<string, { id: string; name: string; connectionId: string | null; required: boolean }>();
  for (const app of apps) {
    byId.set(app.id, {
      id: app.id,
      name: app.name,
      connectionId: null,
      required: true,
    });
  }
  if (session?.appId && session.appName) {
    byId.set(session.appId, {
      id: session.appId,
      name: session.appName,
      connectionId: null,
      required: true,
    });
  }
  return [...byId.values()];
}

function capturedAttachments(attachments: ChatAttachment[]) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    ref: `chat-attachment:${attachment.id}`,
  }));
}

function capturedConversationExcerpts(messages: ChatMessage[]) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => Boolean(message.content?.trim()))
    .slice(-MAX_CAPTURED_CHAT_EXCERPTS)
    .map((message) => ({
      messageId: message.id,
      role: message.role as "user" | "assistant",
      excerpt: message.content!.trim().slice(0, MAX_CAPTURED_CHAT_EXCERPT_CHARS),
      reason: "Recent conversation context",
    }));
}

function capturedTools(messages: ChatMessage[]) {
  return messages
    .filter((message) => Boolean(message.actionRun))
    .slice(-MAX_CAPTURED_CHAT_EXCERPTS)
    .map((message) => ({
      name: message.actionRun!.actionName,
      inputSummary: message.actionRun!.title,
      outputSummary: message.actionRun!.responseText,
      artifactRefs: message.actionRun!.refs.map((ref) => ref.target),
      sideEffects: message.actionRun!.status === "completed" ? ["action completed"] : [],
    }));
}

export function buildHostedCloudWorkCreatePipelineRequest(input: {
  command: "create" | "edit";
  objective: string;
  payload: BootstrapPayload | null;
  project: CloudProject;
  workItem?: CloudWorkItem | null;
  source: "cloud_work_home" | "cloud_work_thread";
}): CreatePipelineRequest | null {
  const objective = input.objective.trim();
  if (!objective) return null;
  const now = new Date().toISOString();
  const profile = input.payload?.profile ?? null;
  const command: CreatePipelineCommand = input.command === "create" ? "/create" : "/edit";
  const surface: CreatePipelineSurface = input.command === "create" ? "hosted_create" : "hosted_edit";
  const hosted = profile?.hosted ?? null;
  const sourceRef = hosted?.sourceRef ?? input.project.defaultBranch ?? null;
  const baseSha = hosted?.sourceCommitSha ?? null;
  const targetAgentId = input.command === "edit"
    ? input.workItem?.assignedAgentId ?? null
    : null;
  if (input.command === "edit" && !targetAgentId) {
    return null;
  }

  return CreatePipelineRequestSchema.parse({
    schemaVersion: "openpond.createPipeline.request.v1",
    id: `create_request_${crypto.randomUUID()}`,
    operation: input.command === "create" ? "create" : "edit",
    surface,
    command,
    objective,
    adapter: {
      kind: "hosted",
      sourceAuthority: "hosted_profile",
      teamId: input.project.teamId,
      projectId: input.project.id,
      activeProfile: profile?.activeProfile ?? "default",
      sourceRef,
      baseSha,
      workItemId: input.workItem?.id ?? null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: {
      id: input.payload?.account.activeProfile?.handle ?? null,
      kind: "user",
      label: input.payload?.account.label ?? null,
    },
    scope: {
      conversationId: input.workItem?.conversationId ?? null,
      workItemId: input.workItem?.id ?? null,
      projectId: input.project.id,
      targetProject: {
        id: input.project.id,
        name: input.project.name,
        workspacePath: null,
        sourceRef: input.project.defaultBranch ?? null,
        baseSha: null,
      },
    },
    context: {
      messageIds: [],
      conversationExcerpts: input.workItem
        ? [
            {
              messageId: null,
              role: "user",
              excerpt: input.workItem.title,
              reason: "Cloud work item context",
            },
          ]
        : [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: input.project.sourceLabel
        ? [`cloud project: ${input.project.sourceLabel}`]
        : [`cloud project: ${input.project.name}`],
    },
    targetAgent: {
      agentId: targetAgentId,
      displayName: input.command === "edit" ? input.workItem?.title ?? null : null,
      defaultActionKey: targetAgentId ? `${targetAgentId}.chat` : "chat",
    },
    metadata: {
      source: input.source,
      selectedCommand: command,
      targetProjectId: input.project.id,
      targetProjectName: input.project.name,
    },
    createdAt: now,
  });
}

export function buildInitialCreatePipelineSnapshot(
  request: CreatePipelineRequest,
): CreatePipelineSnapshot {
  const now = new Date().toISOString();
  const pipelineId = `create_pipeline_${crypto.randomUUID()}`;
  const planId = `create_plan_${crypto.randomUUID()}`;
  const approvalId = `approval_${crypto.randomUUID()}`;
  const workflowCaptureId = `workflow_capture_${crypto.randomUUID()}`;
  const createAgentId = request.targetAgent.agentId ?? createPipelineAgentIdFromObjective(request.objective);
  const questions = createPlanningQuestions(request);
  const awaitingRequiredQuestions = questions.some(
    (question) => question.required && question.status === "pending",
  );
  const sourcePlan = request.operation === "edit" && request.targetAgent.agentId
    ? [
        {
          path: createPipelineSourceRootPathForAgent(request.targetAgent.agentId),
          operation: "update" as const,
          reason: request.objective,
        },
        {
          path: "settings/profile.yaml",
          operation: "update" as const,
          reason: "Preserve the default chat action and hosted profile catalog routing.",
        },
      ]
    : [
        {
          path: createPipelineSourceRootPathForAgent(createAgentId),
          operation: "create" as const,
          reason: request.objective,
        },
        {
          path: "settings/profile.yaml",
          operation: "update" as const,
          reason: "Expose the default chat action through the hosted profile catalog.",
        },
      ];
  const capturedContextSummary = request.context.conversationExcerpts.length > 0
    ? request.context.conversationExcerpts.map((excerpt) => excerpt.excerpt).join("\n")
    : request.context.targetRepoAssumptions.length > 0
      ? request.context.targetRepoAssumptions.join("; ")
      : "Direct prompt create request with no prior chat context.";
  const targetProjectRequirement = request.scope.targetProject?.id
    ? [
        {
          kind: "target_project" as const,
          name: request.scope.targetProject.name ?? request.scope.targetProject.id,
          status: "declared" as const,
          detail: request.scope.targetProject.sourceRef
            ? `source ref ${request.scope.targetProject.sourceRef}`
            : null,
          metadata: {
            projectId: request.scope.targetProject.id,
          },
        },
      ]
    : [];
  const appRequirements = request.context.apps.map((app) => ({
    kind: "integration" as const,
    name: app.name,
    status: app.required ? ("required" as const) : ("declared" as const),
    detail: app.connectionId
      ? `connection ${app.connectionId}`
      : "Connection availability must be checked before publish.",
    metadata: {
      appId: app.id,
      connectionId: app.connectionId,
    },
  }));
  const appRequirementKeys = new Set(
    request.context.apps.flatMap((app) => [app.id.toLowerCase(), app.name.toLowerCase()]),
  );
  const toolProviderRequirements = uniqueNonEmpty(
    request.context.tools.map((tool) => providerNameFromTool(tool.name)),
  )
    .filter((provider) => !appRequirementKeys.has(provider.toLowerCase()))
    .map((provider) => ({
      kind: "external_service" as const,
      name: provider,
      status: "declared" as const,
      detail: "Observed from captured tool/action context.",
      metadata: {
        toolNames: request.context.tools
          .filter((tool) => providerNameFromTool(tool.name) === provider)
          .map((tool) => tool.name),
      },
    }));
  const workflowCaptureRefs = derivedWorkflowCaptureRefs(request);
  const actionShape = inferCreatePipelineActionShape(request);
  const actionShapeDecisionSource = createPipelineActionShapeFromMetadata(request.metadata)
    ? "request_metadata"
    : "default_chat_fallback";

  return CreatePipelineSnapshotSchema.parse({
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id: pipelineId,
    goalId: request.scope.workItemId ?? request.id,
    state: awaitingRequiredQuestions ? "awaiting_questions" : "awaiting_plan_approval",
    request,
    plan: awaitingRequiredQuestions
      ? null
      : {
          schemaVersion: "openpond.createPipeline.plan.v1",
          id: planId,
          goalId: request.scope.workItemId ?? request.id,
          requestId: request.id,
          status: "pending_approval",
          objective: request.objective,
          summary: `${request.operation === "edit" ? "Edit" : "Create"} a source-backed profile agent for: ${request.objective}`,
          capturedContextSummary,
          defaultChatAction: {
            key: request.targetAgent.defaultActionKey ?? "chat",
            label: request.targetAgent.displayName ?? "Chat",
            required: true,
          },
          sourcePlan,
          requirements: [
            ...targetProjectRequirement,
            ...appRequirements,
            ...toolProviderRequirements,
          ],
          checks: [
            { name: "inspect", command: "pnpm agent:inspect", required: true },
            { name: "build", command: "pnpm build", required: true },
            { name: "validate", command: "pnpm agent:validate", required: true },
            { name: "eval", command: "pnpm agent:eval", required: true },
          ],
          approvalId,
          approvedAt: null,
          editedFromPlanId: null,
          metadata: {
            source: request.metadata.source ?? "create_pipeline",
            actionShape,
            actionShapeDecisionSource,
          },
          createdAt: now,
          updatedAt: now,
        },
    workflowCapture: {
      schemaVersion: "openpond.createPipeline.workflowCapture.v1",
      id: workflowCaptureId,
      goalId: request.scope.workItemId ?? request.id,
      requestId: request.id,
      command: request.command,
      objective: request.objective,
      conversationExcerpts: request.context.conversationExcerpts,
      attachments: request.context.attachments,
      apps: request.context.apps,
      tools: request.context.tools,
      sideEffects: workflowCaptureRefs.sideEffects,
      profileActions: workflowCaptureRefs.profileActions,
      externalProviders: workflowCaptureRefs.externalProviders,
      environmentVariables: [],
      files: workflowCaptureRefs.files,
      schedules: [],
      webhooks: [],
      channelTargets: ["openpond_chat"],
      outputArtifacts: workflowCaptureRefs.outputArtifacts,
      targetRepoAssumptions: request.context.targetRepoAssumptions,
      traceRefs: workflowCaptureRefs.traceRefs,
      metadata: {
        source: request.metadata.source ?? "create_pipeline",
        conversationId: request.scope.conversationId,
        workItemId: request.scope.workItemId,
        projectId: request.scope.projectId,
      },
      createdAt: now,
    },
    approvalIds: awaitingRequiredQuestions ? [] : [approvalId],
    questionIds: questions.map((question) => question.id),
    questions,
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: request.adapter.kind === "hosted" ? request.adapter.sourceRef : null,
    blockedReason: null,
    metadata: {
      source: request.metadata.source ?? "create_pipeline",
    },
    createdAt: now,
    updatedAt: now,
  });
}

export function answerCreatePipelineQuestionSnapshot(
  snapshot: CreatePipelineSnapshot,
  questionId: string,
  answerValue: string,
): CreatePipelineSnapshot {
  const now = new Date().toISOString();
  const questions = snapshot.questions ?? [];
  const question = questions.find((candidate) => candidate.id === questionId);
  if (!question) throw new Error("Create question not found.");
  if (question.status !== "pending") return snapshot;

  const option =
    question.options.find((candidate) => candidate.value === answerValue) ??
    question.options.find((candidate) => candidate.id === answerValue) ??
    null;
  if (question.kind === "single_choice" && !option) {
    throw new Error("Choose one of the available Create question answers.");
  }

  const answeredQuestions = questions.map((candidate) =>
    candidate.id === questionId
      ? {
          ...candidate,
          status: "answered" as const,
          answer: {
            value: option?.value ?? answerValue.trim(),
            label: option?.label ?? null,
            detail: option?.description ?? null,
            answeredAt: now,
            metadata: option?.metadata ?? {},
          },
        }
      : candidate,
  );
  const questionAnswers = createQuestionAnswerMetadata(answeredQuestions);
  const pendingRequired = answeredQuestions.some(
    (candidate) => candidate.required && candidate.status === "pending",
  );

  if (pendingRequired) {
    return CreatePipelineSnapshotSchema.parse({
      ...snapshot,
      state: "awaiting_questions",
      questions: answeredQuestions,
      metadata: {
        ...snapshot.metadata,
        questionAnswers,
      },
      updatedAt: now,
    });
  }

  const questionSummary = answeredQuestions
    .filter((candidate) => candidate.answer)
    .map((candidate) => `${candidate.title}: ${candidate.answer?.label ?? candidate.answer?.value}`)
    .join("; ");

  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "planning",
    plan: null,
    approvalIds: [],
    questions: answeredQuestions,
    metadata: {
      ...snapshot.metadata,
      questionAnswers,
      questionSummary,
    },
    updatedAt: now,
  });
}

function createQuestionAnswerMetadata(questions: CreatePipelineQuestion[]): Record<string, unknown> {
  return Object.fromEntries(
    questions
      .filter((question) => question.answer)
      .map((question) => [
        question.id,
        {
          title: question.title,
          value: question.answer!.value,
          label: question.answer!.label,
          detail: question.answer!.detail,
        },
      ]),
  );
}

function createPlanningQuestions(request: CreatePipelineRequest): CreatePipelineQuestion[] {
  void request;
  return [];
}

function derivedWorkflowCaptureRefs(request: CreatePipelineRequest): {
  profileActions: string[];
  externalProviders: string[];
  sideEffects: string[];
  files: string[];
  outputArtifacts: string[];
  traceRefs: string[];
} {
  const outputArtifacts = uniqueNonEmpty(
    request.context.tools.flatMap((tool) => tool.artifactRefs),
  );
  return {
    profileActions: uniqueNonEmpty(request.context.tools.map((tool) => tool.name)),
    externalProviders: uniqueNonEmpty([
      ...request.context.apps.map((app) => app.name),
      ...request.context.tools.map((tool) => providerNameFromTool(tool.name)),
    ]),
    sideEffects: uniqueNonEmpty(request.context.tools.flatMap((tool) => tool.sideEffects)),
    files: uniqueNonEmpty(
      request.context.attachments.map((attachment) =>
        attachment.ref ? `${attachment.name} (${attachment.ref})` : attachment.name,
      ),
    ),
    outputArtifacts,
    traceRefs: outputArtifacts.filter((ref) => /\btrace\b|trace[:/-]/i.test(ref)),
  };
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

export function createPipelineAgentIdFromObjective(objective: string): string {
  return normalizeAgentId(
    objective
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "created-agent",
  );
}

export function createPipelineSourceRootPathForAgent(agentId: string): string {
  return agentId === "default" ? "agent" : `agents/${agentId}`;
}

function normalizeAgentId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "created-agent";
}

export function approveCreatePipelineSnapshot(snapshot: CreatePipelineSnapshot): CreatePipelineSnapshot {
  if (!snapshot.plan) {
    throw new Error("Create plan is not ready to approve yet.");
  }
  const now = new Date().toISOString();
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "applying_source",
    plan: {
      ...snapshot.plan,
      status: "approved",
      approvedAt: snapshot.plan.approvedAt ?? now,
      updatedAt: now,
    },
    updatedAt: now,
  });
}

export function cancelCreatePipelineSnapshot(
  snapshot: CreatePipelineSnapshot,
  reason: string | null = null,
): CreatePipelineSnapshot {
  const now = new Date().toISOString();
  const cleanedReason = reason?.trim() || "Cancelled before source mutation.";
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "blocked",
    plan: snapshot.plan
      ? {
          ...snapshot.plan,
          status: "cancelled",
          approvedAt: null,
          metadata: {
            ...snapshot.plan.metadata,
            cancellationReason: cleanedReason,
          },
          updatedAt: now,
        }
      : null,
    blockedReason: cleanedReason,
    metadata: {
      ...snapshot.metadata,
      cancellationReason: cleanedReason,
    },
    updatedAt: now,
  });
}

export function reviseCreatePipelineSnapshot(
  snapshot: CreatePipelineSnapshot,
  revision: string,
): CreatePipelineSnapshot {
  const cleaned = revision.trim();
  if (!cleaned || !snapshot.plan) return snapshot;
  if (!["planning", "awaiting_plan_approval"].includes(snapshot.state)) return snapshot;
  if (snapshot.plan.status !== "draft" && snapshot.plan.status !== "pending_approval") {
    return snapshot;
  }
  const now = new Date().toISOString();
  const previousPlan = snapshot.plan;
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "awaiting_plan_approval",
    plan: {
      ...previousPlan,
      id: `create_plan_${crypto.randomUUID()}`,
      status: "pending_approval",
      summary: `${previousPlan.summary}\n\nRevision requested: ${cleaned}`,
      sourcePlan: previousPlan.sourcePlan.map((item) => ({
        ...item,
        reason: `${item.reason} Revision requested: ${cleaned}`,
      })),
      approvedAt: null,
      editedFromPlanId: previousPlan.id,
      metadata: {
        ...previousPlan.metadata,
        revision: cleaned,
        supersedesPlanId: previousPlan.id,
      },
      createdAt: now,
      updatedAt: now,
    },
    metadata: {
      ...snapshot.metadata,
      previousPlanId: previousPlan.id,
    },
    updatedAt: now,
  });
}
