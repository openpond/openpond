import { randomUUID } from "node:crypto";
import {
  CreateImproveRunSchema,
  type CreateImproveRun,
  type OpenPondApp,
  type OpenPondProfileState,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import type {
  OpenPondCreatePipelineToolInput,
  OpenPondCreatePipelineToolResult,
} from "../../openpond/capability-tool-registry.js";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import { resolveWorkspaceExecutionTarget } from "../../workspace/workspace-execution-target.js";
import { event, now } from "../../utils.js";
import type { CreateImproveRuntime } from "./runtime.js";

export function createCreateImproveModelTool(deps: {
  getTurn(turnId: string): Promise<Turn | null>;
  loadProfileState?: (() => Promise<OpenPondProfileState>) | null;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  planCreateImproveForTurn: CreateImproveRuntime["planCreateImproveForTurn"];
  persistCreateImproveRun: CreateImproveRuntime["persistCreateImproveRun"];
}) {
  return async function startCreateImproveFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondCreatePipelineToolInput,
  ): Promise<OpenPondCreatePipelineToolResult> {
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required");
    const targetAgentId = input.operation === "edit"
      ? input.targetAgentId?.trim() || context.session.appId || null
      : agentIdFromObjective(objective);
    if (input.operation === "edit" && !targetAgentId) {
      throw new Error("openpond_create_improve edit requires a targeted Agent.");
    }
    const turn = await deps.getTurn(context.turnId);
    if (!turn) throw new Error("Turn not found");
    const profile = deps.loadProfileState ? await deps.loadProfileState() : null;
    const initialRun = buildCreateImproveRun({
      session: context.session,
      turnId: context.turnId,
      profile,
      operation: input.operation,
      objective,
      targetAgentId,
      mentionedApps: context.mentionedApps,
      userPrompt: context.userPrompt,
      source: input.source ?? "model_tool",
    });
    await deps.appendRuntimeEvent(event({
      sessionId: context.session.id,
      turnId: context.turnId,
      name: "create_improve.updated",
      source: "provider",
      appId: context.session.appId,
      status: "pending",
      output: "Create/Improve planner is preparing the plan.",
      data: { createImproveRun: initialRun },
    }));
    const plannedRun = await deps.planCreateImproveForTurn({
      session: context.session,
      turn,
      run: initialRun,
      signal: context.signal,
    });
    await deps.persistCreateImproveRun({
      session: context.session,
      turnId: context.turnId,
      run: plannedRun,
      source: "provider",
    });
    return {
      runId: plannedRun.id,
      operation: plannedRun.operation,
      state: plannedRun.state,
      nextStep: createImproveToolNextStep(plannedRun),
    };
  };
}

function buildCreateImproveRun(input: {
  session: Session;
  turnId: string;
  profile: OpenPondProfileState | null;
  operation: "create" | "edit";
  objective: string;
  targetAgentId: string | null;
  mentionedApps: OpenPondApp[];
  userPrompt: string;
  source: "natural_language" | "model_tool";
}): CreateImproveRun {
  const executionTarget = resolveWorkspaceExecutionTarget({ session: input.session });
  const localProfileLoaded =
    executionTarget.target !== "sandbox" &&
    input.profile?.mode === "local" &&
    Boolean(input.profile.repoPath) &&
    Boolean(input.profile.sourcePath);
  const hosted = input.profile?.hosted ?? null;
  const timestamp = now();
  return CreateImproveRunSchema.parse({
    schemaVersion: "openpond.createImprove.run.v1",
    id: `create_improve_${randomUUID()}`,
    revision: 0,
    operation: input.operation === "create" ? "create" : "improve",
    surface: input.operation === "create" ? "direct_prompt_create" : "direct_prompt_improve",
    command: input.operation === "create" ? "/create" : "/edit",
    objective: input.objective,
    state: "planning",
    adapter: localProfileLoaded
      ? {
          kind: "local",
          sourceAuthority: "local_profile",
          activeProfile: input.profile?.activeProfile ?? null,
          repoPath: input.profile?.repoPath ?? null,
          sourcePath: input.profile?.sourcePath ?? null,
          localHead: input.profile?.git?.head ?? null,
          confirmationPolicy: "always_require_plan_approval",
        }
      : {
          kind: "hosted",
          sourceAuthority: "hosted_profile",
          teamId: input.session.cloudTeamId ?? hosted?.teamId ?? null,
          projectId: input.session.cloudProjectId ?? hosted?.projectId ?? null,
          activeProfile: input.profile?.activeProfile ?? "default",
          sourceRef: hosted?.sourceRef ?? null,
          baseSha: hosted?.sourceCommitSha ?? null,
          workItemId: null,
          confirmationPolicy: "always_require_plan_approval",
        },
    actor: { id: null, kind: "user", label: null },
    scope: {
      profileId: input.profile?.activeProfile ?? "default",
      conversationId: input.session.id,
      originTurnId: input.turnId,
      workItemId: null,
      projectId: input.session.cloudProjectId ?? input.session.localProjectId ?? null,
      targetProject: input.session.workspaceId
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
      messageIds: [],
      conversationExcerpts: [{
        messageId: null,
        role: "user",
        excerpt: (input.userPrompt || input.objective).slice(0, 1200),
        reason: "Natural-language Create/Improve tool request",
      }],
      attachments: [],
      apps: capturedApps(input.mentionedApps, input.session),
      tools: [],
      signalRefs: [],
      evalRefs: [],
      targetRepoAssumptions: targetRepoAssumptions(input.session),
    },
    target: {
      kind: "agent",
      id: input.targetAgentId,
      displayName: input.targetAgentId === input.session.appId ? input.session.appName : null,
      defaultActionKey: input.targetAgentId ? `${input.targetAgentId}.chat` : "chat",
    },
    plan: null,
    workflowCapture: null,
    executionPolicy: {
      mode: "background",
      pauseAllowed: true,
      cancellationAllowed: true,
    },
    iterationPolicy: {
      mode: "single",
      maximumAttempts: 1,
      currentAttempt: 0,
    },
    approvalIds: [],
    questionIds: [],
    questions: [],
    candidates: [],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: [],
    externalExecutionRefs: [],
    localProfileCommit: localProfileLoaded ? input.profile?.git?.head ?? null : null,
    hostedSourceCommit: null,
    hostedSourceRef: localProfileLoaded ? null : hosted?.sourceRef ?? null,
    releaseOutcome: {
      status: "not_requested",
      profileCommit: null,
      profileTag: null,
      releaseReceiptRef: null,
      updatedAt: null,
    },
    blockedReason: null,
    appliedActionIds: [],
    metadata: {
      source: "native_model_tool",
      toolName: "openpond_create_improve",
      routingSource: input.source,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function agentIdFromObjective(objective: string): string {
  const normalized = objective
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "created-agent";
}

function capturedApps(apps: OpenPondApp[], session: Session) {
  const byId = new Map<string, {
    id: string;
    name: string;
    connectionId: string | null;
    required: boolean;
  }>();
  for (const app of apps) {
    byId.set(app.id, { id: app.id, name: app.name, connectionId: null, required: true });
  }
  if (session.appId && session.appName) {
    byId.set(session.appId, {
      id: session.appId,
      name: session.appName,
      connectionId: null,
      required: true,
    });
  }
  return [...byId.values()];
}

function targetRepoAssumptions(session: Session): string[] {
  const target = resolveWorkspaceExecutionTarget({ session });
  if (target.target === "sandbox") {
    return [
      `${target.hybrid ? "hybrid sandbox" : "sandbox"}: ${target.sandboxId ?? "pending"}`,
      ...(target.cloudProjectId ? [`cloud project: ${target.cloudProjectId}`] : []),
      ...(target.localProjectId ? [`local project: ${target.localProjectId}`] : []),
    ];
  }
  if (target.target === "local" && target.cwd) return [`workspace: ${target.cwd}`];
  if (target.target === "local" && target.localProjectId) {
    return [`local project: ${target.localProjectId}`];
  }
  return [];
}

function createImproveToolNextStep(run: CreateImproveRun): string {
  if (run.state === "awaiting_questions") {
    return "Create/Improve is waiting for user answers before planning can continue.";
  }
  if (run.state === "awaiting_plan_approval") {
    return "Create/Improve plan is ready for review and approval.";
  }
  if (run.state === "blocked" || run.state === "failed") {
    return run.blockedReason ?? "Create/Improve could not prepare a plan.";
  }
  if (run.state === "cancelled") return "Create/Improve was cancelled.";
  return `Create/Improve state: ${run.state}.`;
}
