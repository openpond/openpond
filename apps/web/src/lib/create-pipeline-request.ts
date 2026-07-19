import {
  CreateImprovePlanSchema,
  CreateImproveRunSchema,
  CreateImproveWorkflowCaptureSchema,
  createImproveActionShapeFromMetadata,
  inferCreateImproveActionShape,
  nextCreateImproveRunRevision,
  type BootstrapPayload,
  type ChatAttachment,
  type CloudProject,
  type CloudWorkItem,
  type CreateImproveCommand,
  type CreateImproveQuestion,
  type CreateImproveRun,
  type CreateImproveSurface,
  type OpenPondApp,
  type Session,
} from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import type { ParsedComposerSlashCommand } from "./composer-slash-commands";

const MAX_CAPTURED_CHAT_EXCERPTS = 6;
const MAX_CAPTURED_CHAT_EXCERPT_CHARS = 1200;

export function buildComposerCreateImproveRun(input: {
  parsed: ParsedComposerSlashCommand;
  prompt: string;
  payload: BootstrapPayload | null;
  session: Session | null;
  messages?: ChatMessage[];
  attachments?: ChatAttachment[];
  apps?: OpenPondApp[];
}): CreateImproveRun | null {
  if (input.parsed.command !== "create" && input.parsed.command !== "edit") return null;
  const editTarget = input.parsed.command === "edit"
    ? parseEditAgentTarget(input.parsed.args)
    : null;
  const objective = editTarget?.objective || input.parsed.args || input.prompt.trim();
  if (!objective) return null;
  const profile = input.payload?.profile ?? null;
  const command: CreateImproveCommand = input.parsed.command === "create" ? "/create" : "/edit";
  const conversationExcerpts = capturedConversationExcerpts(input.messages ?? []);
  const hasCapturedConversation = conversationExcerpts.length > 0;
  const surface: CreateImproveSurface = input.parsed.command === "create"
    ? hasCapturedConversation ? "context_backed_create" : "direct_prompt_create"
    : hasCapturedConversation ? "context_backed_improve" : "direct_prompt_improve";
  const targetAgentId = input.parsed.command === "edit"
    ? editTarget?.agentId ?? input.session?.appId ?? null
    : createPipelineAgentIdFromObjective(objective);
  if (input.parsed.command === "edit" && !targetAgentId) return null;
  return baseCreateImproveRun({
    operation: input.parsed.command === "create" ? "create" : "improve",
    surface,
    command,
    objective,
    profile: {
      id: profile?.activeProfile ?? "default",
      local: profile?.mode === "local",
      repoPath: profile?.repoPath ?? null,
      sourcePath: profile?.sourcePath ?? null,
      localHead: profile?.git?.head ?? null,
      hostedSourceRef: profile?.hosted?.sourceRef ?? null,
      hostedSourceCommit: profile?.hosted?.sourceCommitSha ?? null,
    },
    hosted: {
      teamId: input.session?.cloudTeamId ?? input.payload?.preferences.defaultTeamId ?? null,
      projectId: input.session?.cloudProjectId ?? null,
      workItemId: null,
    },
    actor: {
      id: input.payload?.account.activeProfile?.handle ?? null,
      label: input.payload?.account.label ?? null,
    },
    session: input.session,
    workItemId: null,
    targetAgentId,
    targetAgentName: input.parsed.command === "edit"
      ? editTarget?.agentId ?? input.session?.appName ?? null
      : null,
    context: {
      messageIds: conversationExcerpts
        .map((excerpt) => excerpt.messageId)
        .filter((id): id is string => Boolean(id)),
      conversationExcerpts,
      attachments: capturedAttachments(input.attachments ?? []),
      apps: capturedApps(input.apps ?? [], input.session),
      tools: capturedTools(input.messages ?? []),
      evalRefs: editTarget?.evalRefs ?? [],
      targetRepoAssumptions: input.session?.cwd ? [`workspace: ${input.session.cwd}`] : [],
    },
    metadata: {
      source: "web_composer_slash",
      selectedCommand: command,
      capturedMessageCount: conversationExcerpts.length,
    },
  });
}

export function buildLabAgentCreateImproveRun(input: {
  objective: string;
  payload: BootstrapPayload | null;
  session: Session;
}): CreateImproveRun | null {
  const objective = input.objective.trim();
  if (!objective) return null;
  const profile = input.payload?.profile ?? null;
  const targetAgentId = createPipelineAgentIdFromObjective(objective);
  return baseCreateImproveRun({
    operation: "create",
    surface: "lab_create",
    command: "lab_create",
    objective,
    profile: {
      id: profile?.activeProfile ?? "default",
      local: profile?.mode === "local",
      repoPath: profile?.repoPath ?? null,
      sourcePath: profile?.sourcePath ?? null,
      localHead: profile?.git?.head ?? null,
      hostedSourceRef: profile?.hosted?.sourceRef ?? null,
      hostedSourceCommit: profile?.hosted?.sourceCommitSha ?? null,
    },
    hosted: {
      teamId: input.session.cloudTeamId ?? input.payload?.preferences.defaultTeamId ?? null,
      projectId: input.session.cloudProjectId ?? null,
      workItemId: null,
    },
    actor: {
      id: input.payload?.account.activeProfile?.handle ?? null,
      label: input.payload?.account.label ?? null,
    },
    session: input.session,
    workItemId: null,
    targetAgentId,
    targetAgentName: null,
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      evalRefs: [],
      targetRepoAssumptions: input.session.cwd
        ? [`workspace: ${input.session.cwd}`]
        : [],
    },
    metadata: {
      source: "lab_agent_create",
      selectedCommand: "lab_create",
      capturedMessageCount: 0,
      hiddenExecutionSession: true,
    },
  });
}

export function buildLabAgentImproveRun(input: {
  agentId: string;
  agentName?: string | null;
  objective: string;
  payload: BootstrapPayload | null;
  session: Session;
}): CreateImproveRun | null {
  const objective = input.objective.trim();
  const targetAgentId = normalizeAgentId(input.agentId);
  if (!objective || !targetAgentId) return null;
  const profile = input.payload?.profile ?? null;
  return baseCreateImproveRun({
    operation: "improve",
    surface: "lab_improve",
    command: "lab_improve",
    objective,
    profile: {
      id: profile?.activeProfile ?? "default",
      local: profile?.mode === "local",
      repoPath: profile?.repoPath ?? null,
      sourcePath: profile?.sourcePath ?? null,
      localHead: profile?.git?.head ?? null,
      hostedSourceRef: profile?.hosted?.sourceRef ?? null,
      hostedSourceCommit: profile?.hosted?.sourceCommitSha ?? null,
    },
    hosted: {
      teamId: input.session.cloudTeamId ?? input.payload?.preferences.defaultTeamId ?? null,
      projectId: input.session.cloudProjectId ?? null,
      workItemId: null,
    },
    actor: {
      id: input.payload?.account.activeProfile?.handle ?? null,
      label: input.payload?.account.label ?? null,
    },
    session: input.session,
    workItemId: null,
    targetAgentId,
    targetAgentName: input.agentName?.trim() || targetAgentId,
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      evalRefs: [],
      targetRepoAssumptions: input.session.cwd
        ? [`workspace: ${input.session.cwd}`]
        : [],
    },
    metadata: {
      source: "lab_agent_improve",
      selectedCommand: "lab_improve",
      capturedMessageCount: 0,
      hiddenExecutionSession: true,
    },
  });
}

export function continueLabAgentRunFromTaskset(input: {
  authoringRun: CreateImproveRun;
  agentId?: string;
  agentName?: string | null;
  objective: string;
  payload: BootstrapPayload | null;
  session: Session;
  operation: "create" | "improve";
}): CreateImproveRun {
  if (!input.authoringRun.tasksetRef || input.authoringRun.state !== "ready") {
    throw new Error("Approve the shared Taskset before starting Agent authoring.");
  }
  const fresh = input.operation === "create"
    ? buildLabAgentCreateImproveRun({
        objective: input.objective,
        payload: input.payload,
        session: input.session,
      })
    : buildLabAgentImproveRun({
        agentId: input.agentId ?? "",
        agentName: input.agentName,
        objective: input.objective,
        payload: input.payload,
        session: input.session,
      });
  if (!fresh) throw new Error("The Agent target and objective are required.");
  return nextCreateImproveRunRevision(input.authoringRun, {
    operation: fresh.operation,
    surface: fresh.surface,
    command: fresh.command,
    objective: fresh.objective,
    state: "planning",
    adapter: fresh.adapter,
    actor: fresh.actor,
    scope: fresh.scope,
    context: {
      ...fresh.context,
      signalRefs: [...new Set([
        ...input.authoringRun.context.signalRefs,
        ...fresh.context.signalRefs,
      ])],
      evalRefs: [...new Set([
        ...input.authoringRun.context.evalRefs,
        ...fresh.context.evalRefs,
      ])],
    },
    target: fresh.target,
    targetSelection: {
      status: "confirmed",
      preselectedKind: input.authoringRun.targetSelection?.preselectedKind ?? "agent",
      confirmedKind: "agent",
    },
    plan: null,
    workflowCapture: null,
    approvalIds: [],
    questionIds: [],
    questions: [],
    candidates: [],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: [...new Set([
      ...input.authoringRun.sourceRefs,
      ...fresh.sourceRefs,
      input.authoringRun.tasksetRef.id,
    ])],
    externalExecutionRefs: [],
    blockedReason: null,
    metadata: {
      ...input.authoringRun.metadata,
      ...fresh.metadata,
      sharedAuthoringRun: true,
      tasksetRevision: input.authoringRun.tasksetRef.revision,
      tasksetHash: input.authoringRun.tasksetRef.contentHash,
    },
    updatedAt: new Date().toISOString(),
  });
}

export function buildHostedCloudWorkCreateImproveRun(input: {
  command: "create" | "edit";
  objective: string;
  payload: BootstrapPayload | null;
  project: CloudProject;
  workItem?: CloudWorkItem | null;
  source: "cloud_work_home" | "cloud_work_thread";
}): CreateImproveRun | null {
  const objective = input.objective.trim();
  if (!objective) return null;
  const targetAgentId = input.command === "edit"
    ? input.workItem?.assignedAgentId ?? null
    : createPipelineAgentIdFromObjective(objective);
  if (input.command === "edit" && !targetAgentId) return null;
  const profile = input.payload?.profile ?? null;
  return baseCreateImproveRun({
    operation: input.command === "create" ? "create" : "improve",
    surface: input.command === "create" ? "hosted_create" : "hosted_improve",
    command: input.command === "create" ? "/create" : "/edit",
    objective,
    profile: {
      id: profile?.activeProfile ?? "default",
      local: false,
      repoPath: null,
      sourcePath: null,
      localHead: null,
      hostedSourceRef: profile?.hosted?.sourceRef ?? input.project.defaultBranch ?? null,
      hostedSourceCommit: profile?.hosted?.sourceCommitSha ?? null,
    },
    hosted: {
      teamId: input.project.teamId,
      projectId: input.project.id,
      workItemId: input.workItem?.id ?? null,
    },
    actor: {
      id: input.payload?.account.activeProfile?.handle ?? null,
      label: input.payload?.account.label ?? null,
    },
    session: null,
    conversationId: input.workItem?.conversationId ?? null,
    project: input.project,
    workItemId: input.workItem?.id ?? null,
    targetAgentId,
    targetAgentName: input.command === "edit" ? input.workItem?.title ?? null : null,
    context: {
      messageIds: [],
      conversationExcerpts: input.workItem
        ? [{
            messageId: null,
            role: "user",
            excerpt: input.workItem.title,
            reason: "Cloud work item context",
          }]
        : [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: [
        `cloud project: ${input.project.sourceLabel ?? input.project.name}`,
      ],
    },
    metadata: {
      source: input.source,
      targetProjectId: input.project.id,
      targetProjectName: input.project.name,
    },
  });
}

export function buildInitialCreateImproveRun(run: CreateImproveRun): CreateImproveRun {
  if (run.plan || run.state !== "planning") return run;
  const timestamp = new Date().toISOString();
  const targetId = run.target.kind === "agent"
    ? run.target.id ?? createPipelineAgentIdFromObjective(run.objective)
    : run.target.id;
  const target = run.target.kind === "agent"
    ? {
        ...run.target,
        id: targetId,
        defaultActionKey: run.target.defaultActionKey ?? `${targetId}.chat`,
      }
    : run.target;
  const sourcePlan = target.kind === "agent"
    ? run.operation === "improve" && target.id
      ? [
          {
            path: createPipelineSourceRootPathForAgent(target.id),
            operation: "update" as const,
            reason: run.objective,
          },
          {
            path: "settings/profile.yaml",
            operation: "update" as const,
            reason: "Preserve the active Profile routing.",
          },
        ]
      : [
          {
            path: createPipelineSourceRootPathForAgent(target.id ?? "created-agent"),
            operation: "create" as const,
            reason: run.objective,
          },
          {
            path: "settings/profile.yaml",
            operation: "update" as const,
            reason: "Register the generated Agent in the active Profile.",
          },
        ]
    : [];
  const workflowCapture = workflowCaptureForRun(run, timestamp);
  const actionShape = inferCreateImproveActionShape({ ...run, target });
  const plan = CreateImprovePlanSchema.parse({
    schemaVersion: "openpond.createImprove.plan.v1",
    id: `create_improve_plan_${crypto.randomUUID()}`,
    runId: run.id,
    status: "pending_approval",
    objective: run.objective,
    summary: `${run.operation === "improve" ? "Improve" : "Create"} ${target.displayName ?? target.kind} for: ${run.objective}`,
    capturedContextSummary: capturedContextSummary(run),
    defaultChatAction: {
      key: target.kind === "agent" ? target.defaultActionKey ?? "chat" : "chat",
      label: target.displayName ?? "Chat",
      required: true,
    },
    sourcePlan,
    requirements: setupRequirements(run),
    checks: target.kind === "agent"
      ? [
          { name: "inspect", command: "pnpm agent:inspect", required: true },
          { name: "build", command: "pnpm build", required: true },
          { name: "validate", command: "pnpm agent:validate", required: true },
          { name: "eval", command: "pnpm agent:eval", required: true },
        ]
      : [],
    approvalId: `approval_${crypto.randomUUID()}`,
    approvedAt: null,
    editedFromPlanId: null,
    metadata: {
      source: run.metadata.source ?? "create_improve",
      actionShape,
      actionShapeDecisionSource: createImproveActionShapeFromMetadata(run.metadata)
        ? "request_metadata"
        : "default_chat_fallback",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return nextCreateImproveRunRevision(run, {
    state: "awaiting_plan_approval",
    target,
    plan,
    workflowCapture,
    approvalIds: plan.approvalId ? [plan.approvalId] : [],
    questionIds: run.questions.map((question) => question.id),
    blockedReason: null,
    metadata: { ...run.metadata, source: run.metadata.source ?? "create_improve" },
    updatedAt: timestamp,
  });
}

export function answerCreateImproveQuestionRun(
  run: CreateImproveRun,
  questionId: string,
  value: string,
): CreateImproveRun {
  const timestamp = new Date().toISOString();
  const question = run.questions.find((candidate) => candidate.id === questionId);
  if (!question || question.status !== "pending") return run;
  const option = question.options.find((candidate) => candidate.value === value);
  const questions = run.questions.map((candidate) =>
    candidate.id === questionId
      ? {
          ...candidate,
          status: "answered" as const,
          answer: {
            value,
            label: option?.label ?? null,
            detail: null,
            answeredAt: timestamp,
            metadata: {},
          },
        }
      : candidate,
  );
  return nextCreateImproveRunRevision(run, {
    state: questions.some((candidate) => candidate.required && candidate.status === "pending")
      ? "awaiting_questions"
      : "planning",
    questions,
    updatedAt: timestamp,
  }, `cloud-answer:${questionId}:${crypto.randomUUID()}`);
}

export function approveCreateImproveRun(run: CreateImproveRun): CreateImproveRun {
  if (!run.plan) throw new Error("Create/Improve plan is not ready to approve yet.");
  const timestamp = new Date().toISOString();
  return nextCreateImproveRunRevision(run, {
    state: run.target.kind === "model" ? "evaluating" : "applying_source",
    plan: {
      ...run.plan,
      status: "approved",
      approvedAt: run.plan.approvedAt ?? timestamp,
      updatedAt: timestamp,
    },
    blockedReason: null,
    updatedAt: timestamp,
  }, `cloud-approve:${crypto.randomUUID()}`);
}

export function cancelCreateImproveRun(
  run: CreateImproveRun,
  reason: string | null = null,
): CreateImproveRun {
  const timestamp = new Date().toISOString();
  const cleanedReason = reason?.trim() || "Cancelled before source mutation.";
  return nextCreateImproveRunRevision(run, {
    state: "cancelled",
    plan: run.plan
      ? {
          ...run.plan,
          status: "cancelled",
          approvedAt: null,
          metadata: { ...run.plan.metadata, cancellationReason: cleanedReason },
          updatedAt: timestamp,
        }
      : null,
    blockedReason: cleanedReason,
    metadata: { ...run.metadata, cancellationReason: cleanedReason },
    updatedAt: timestamp,
  }, `cloud-cancel:${crypto.randomUUID()}`);
}

export function reviseCreateImproveRun(
  run: CreateImproveRun,
  revision: string,
): CreateImproveRun {
  const cleaned = revision.trim();
  if (!cleaned || !run.plan || run.state !== "awaiting_plan_approval") return run;
  const timestamp = new Date().toISOString();
  const previousPlan = run.plan;
  return nextCreateImproveRunRevision(run, {
    state: "awaiting_plan_approval",
    plan: {
      ...previousPlan,
      id: `create_improve_plan_${crypto.randomUUID()}`,
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
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    metadata: { ...run.metadata, previousPlanId: previousPlan.id },
    updatedAt: timestamp,
  }, `cloud-revise:${crypto.randomUUID()}`);
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

function baseCreateImproveRun(input: {
  operation: CreateImproveRun["operation"];
  surface: CreateImproveSurface;
  command: CreateImproveCommand;
  objective: string;
  profile: {
    id: string;
    local: boolean;
    repoPath: string | null;
    sourcePath: string | null;
    localHead: string | null;
    hostedSourceRef: string | null;
    hostedSourceCommit: string | null;
  };
  hosted: { teamId: string | null; projectId: string | null; workItemId: string | null };
  actor: { id: string | null; label: string | null };
  session: Session | null;
  conversationId?: string | null;
  project?: CloudProject;
  workItemId: string | null;
  targetAgentId: string | null;
  targetAgentName: string | null;
  context: {
    messageIds: string[];
    conversationExcerpts: CreateImproveRun["context"]["conversationExcerpts"];
    attachments: CreateImproveRun["context"]["attachments"];
    apps: CreateImproveRun["context"]["apps"];
    tools: CreateImproveRun["context"]["tools"];
    evalRefs?: string[];
    targetRepoAssumptions: string[];
  };
  metadata: Record<string, unknown>;
}): CreateImproveRun {
  const timestamp = new Date().toISOString();
  const projectId = input.project?.id
    ?? input.session?.cloudProjectId
    ?? input.session?.localProjectId
    ?? input.hosted.projectId;
  return CreateImproveRunSchema.parse({
    schemaVersion: "openpond.createImprove.run.v1",
    id: `create_improve_${crypto.randomUUID()}`,
    revision: 0,
    operation: input.operation,
    surface: input.surface,
    command: input.command,
    objective: input.objective,
    state: "planning",
    adapter: input.profile.local
      ? {
          kind: "local",
          sourceAuthority: "local_profile",
          activeProfile: input.profile.id,
          repoPath: input.profile.repoPath,
          sourcePath: input.profile.sourcePath,
          localHead: input.profile.localHead,
          confirmationPolicy: "always_require_plan_approval",
        }
      : {
          kind: "hosted",
          sourceAuthority: "hosted_profile",
          teamId: input.hosted.teamId,
          projectId: input.hosted.projectId,
          activeProfile: input.profile.id,
          sourceRef: input.profile.hostedSourceRef,
          baseSha: input.profile.hostedSourceCommit,
          workItemId: input.hosted.workItemId,
          confirmationPolicy: "always_require_plan_approval",
        },
    actor: { id: input.actor.id, kind: "user", label: input.actor.label },
    scope: {
      profileId: input.profile.id,
      conversationId: input.conversationId ?? input.session?.id ?? null,
      originTurnId: null,
      workItemId: input.workItemId,
      projectId,
      targetProject: input.project
        ? {
            id: input.project.id,
            name: input.project.name,
            workspacePath: null,
            sourceRef: input.project.defaultBranch ?? null,
            baseSha: null,
          }
        : input.session?.workspaceId
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
      ...input.context,
      signalRefs: [],
      evalRefs: input.context.evalRefs ?? [],
    },
    target: {
      kind: "agent",
      id: input.targetAgentId,
      displayName: input.targetAgentName,
      defaultActionKey: input.targetAgentId ? `${input.targetAgentId}.chat` : "chat",
    },
    plan: null,
    workflowCapture: null,
    executionPolicy: { mode: "background", pauseAllowed: true, cancellationAllowed: true },
    iterationPolicy: { mode: "single", maximumAttempts: 1, currentAttempt: 0 },
    approvalIds: [],
    questionIds: [],
    questions: [],
    candidates: [],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: [],
    externalExecutionRefs: [],
    localProfileCommit: input.profile.localHead,
    hostedSourceCommit: input.profile.hostedSourceCommit,
    hostedSourceRef: input.profile.hostedSourceRef,
    releaseOutcome: {
      status: "not_requested",
      profileCommit: null,
      profileTag: null,
      releaseReceiptRef: null,
      updatedAt: null,
    },
    blockedReason: null,
    appliedActionIds: [],
    metadata: input.metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function workflowCaptureForRun(run: CreateImproveRun, timestamp: string) {
  const outputArtifacts = uniqueNonEmpty(run.context.tools.flatMap((tool) => tool.artifactRefs));
  return CreateImproveWorkflowCaptureSchema.parse({
    schemaVersion: "openpond.createImprove.workflowCapture.v1",
    id: `workflow_capture_${crypto.randomUUID()}`,
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
      source: run.metadata.source ?? "create_improve",
      conversationId: run.scope.conversationId,
      workItemId: run.scope.workItemId,
      projectId: run.scope.projectId,
    },
    createdAt: timestamp,
  });
}

function setupRequirements(run: CreateImproveRun) {
  const project = run.scope.targetProject?.id
    ? [{
        kind: "target_project" as const,
        name: run.scope.targetProject.name ?? run.scope.targetProject.id,
        status: "declared" as const,
        detail: run.scope.targetProject.sourceRef
          ? `source ref ${run.scope.targetProject.sourceRef}`
          : null,
        metadata: { projectId: run.scope.targetProject.id },
      }]
    : [];
  const apps = run.context.apps.map((app) => ({
    kind: "integration" as const,
    name: app.name,
    status: app.required ? "required" as const : "declared" as const,
    detail: app.connectionId
      ? `connection ${app.connectionId}`
      : "Connection availability must be checked before publish.",
    metadata: { appId: app.id, connectionId: app.connectionId },
  }));
  return [...project, ...apps];
}

function capturedContextSummary(run: CreateImproveRun): string {
  if (run.context.conversationExcerpts.length > 0) {
    return run.context.conversationExcerpts.map((excerpt) => excerpt.excerpt).join("\n");
  }
  if (run.context.targetRepoAssumptions.length > 0) {
    return run.context.targetRepoAssumptions.join("; ");
  }
  return "Direct Create/Improve request with no prior chat context.";
}

function capturedApps(apps: OpenPondApp[], session: Session | null) {
  const byId = new Map<string, {
    id: string;
    name: string;
    connectionId: string | null;
    required: boolean;
  }>();
  for (const app of apps) {
    byId.set(app.id, { id: app.id, name: app.name, connectionId: null, required: true });
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

function parseEditAgentTarget(value: string): {
  agentId: string;
  objective: string;
  evalRefs: string[];
} | null {
  const match = /^--agent\s+([a-z0-9._-]+)\s*([\s\S]*)$/i.exec(value.trim());
  if (!match?.[1]) return null;
  let remainder = match[2]?.trim() ?? "";
  const evalRefs: string[] = [];
  while (remainder.startsWith("--eval")) {
    const evalMatch = /^--eval\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*([\s\S]*)$/i.exec(remainder);
    const evalRef = evalMatch?.[1] ?? evalMatch?.[2] ?? evalMatch?.[3] ?? null;
    if (!evalMatch || !evalRef) break;
    evalRefs.push(evalRef);
    remainder = evalMatch[4]?.trim() ?? "";
  }
  return {
    agentId: normalizeAgentId(match[1]),
    objective: remainder || `Improve ${match[1]}.`,
    evalRefs: uniqueNonEmpty(evalRefs),
  };
}

function providerNameFromTool(name: string): string {
  const [provider] = name.split(".");
  return provider?.trim() || name;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

export function createQuestionAnswerMetadata(
  questions: CreateImproveQuestion[],
): Record<string, unknown> {
  return Object.fromEntries(
    questions
      .filter((question) => question.answer)
      .map((question) => [question.id, question.answer]),
  );
}
