import { randomUUID } from "node:crypto";
import {
  CreatePipelineRequestSchema,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
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
import type { CreatePipelineRuntime } from "./runtime.js";

export function createCreatePipelineModelTool(deps: {
  getTurn(turnId: string): Promise<Turn | null>;
  loadProfileState?: (() => Promise<OpenPondProfileState>) | null;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  planCreatePipelineForTurn: CreatePipelineRuntime["planCreatePipelineForTurn"];
  persistCreatePipelineSnapshot: CreatePipelineRuntime["persistCreatePipelineSnapshot"];
}) {
  return async function startCreatePipelineFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondCreatePipelineToolInput,
  ): Promise<OpenPondCreatePipelineToolResult> {
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required");
    const targetAgentId = input.operation === "edit"
      ? input.targetAgentId?.trim() || context.session.appId || null
      : null;
    if (input.operation === "edit" && !targetAgentId) {
      throw new Error("openpond_create_pipeline edit requires targetAgentId or a selected agent in the current chat.");
    }
    const turn = await deps.getTurn(context.turnId);
    if (!turn) throw new Error("Turn not found");
    const profile = deps.loadProfileState ? await deps.loadProfileState() : null;
    const request = buildCreatePipelineRequest({
      session: context.session,
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
      name: "create_pipeline.updated",
      source: "provider",
      appId: context.session.appId,
      status: "pending",
      output: "Create planner is preparing the plan.",
      data: { createPipelineRequest: request, createPipeline: null },
    }));
    const snapshot = await deps.planCreatePipelineForTurn({
      session: context.session,
      turn,
      request,
      previousSnapshot: null,
      signal: context.signal,
    });
    await deps.persistCreatePipelineSnapshot({
      session: context.session,
      turnId: context.turnId,
      request,
      snapshot,
      source: "provider",
    });
    return {
      requestId: request.id,
      pipelineId: snapshot.id,
      operation: input.operation,
      state: snapshot.state,
      nextStep: createPipelineToolNextStep(snapshot),
    };
  };
}

function buildCreatePipelineRequest(input: {
  session: Session;
  profile: OpenPondProfileState | null;
  operation: "create" | "edit";
  objective: string;
  targetAgentId: string | null;
  mentionedApps: OpenPondApp[];
  userPrompt: string;
  source: "natural_language" | "model_tool";
}): CreatePipelineRequest {
  const executionTarget = resolveWorkspaceExecutionTarget({ session: input.session });
  const localProfileLoaded =
    executionTarget.target !== "sandbox" &&
    input.profile?.mode === "local" &&
    Boolean(input.profile.repoPath) &&
    Boolean(input.profile.sourcePath);
  const hosted = input.profile?.hosted ?? null;
  return CreatePipelineRequestSchema.parse({
    schemaVersion: "openpond.createPipeline.request.v1",
    id: `create_request_${randomUUID()}`,
    operation: input.operation,
    surface: input.operation === "create" ? "direct_prompt_create" : "direct_prompt_edit",
    command: input.operation === "create" ? "/create" : "/edit",
    objective: input.objective,
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
      conversationId: input.session.id,
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
        reason: "Natural-language Create Pipeline tool request",
      }],
      attachments: [],
      apps: capturedApps(input.mentionedApps, input.session),
      tools: [],
      targetRepoAssumptions: targetRepoAssumptions(input.session),
    },
    targetAgent: {
      agentId: input.targetAgentId,
      displayName: input.targetAgentId === input.session.appId ? input.session.appName : null,
      defaultActionKey: input.targetAgentId ? `${input.targetAgentId}.chat` : "chat",
    },
    metadata: {
      source: "native_model_tool",
      toolName: "openpond_create_pipeline",
      routingSource: input.source,
    },
    createdAt: now(),
  });
}

function capturedApps(apps: OpenPondApp[], session: Session) {
  const byId = new Map<string, { id: string; name: string; connectionId: string | null; required: boolean }>();
  for (const app of apps) byId.set(app.id, { id: app.id, name: app.name, connectionId: null, required: true });
  if (session.appId && session.appName) {
    byId.set(session.appId, { id: session.appId, name: session.appName, connectionId: null, required: true });
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
  if (target.target === "local" && target.localProjectId) return [`local project: ${target.localProjectId}`];
  return [];
}

function createPipelineToolNextStep(snapshot: CreatePipelineSnapshot): string {
  if (snapshot.state === "awaiting_questions") return "Create Pipeline is waiting for user answers before planning can continue.";
  if (snapshot.state === "awaiting_plan_approval") return "Create Pipeline plan is ready for review and approval.";
  if (snapshot.state === "blocked" || snapshot.state === "failed") {
    return snapshot.blockedReason ?? "Create Pipeline could not prepare a plan.";
  }
  if (snapshot.state === "cancelled") return "Create Pipeline was cancelled.";
  return `Create Pipeline state: ${snapshot.state}.`;
}
