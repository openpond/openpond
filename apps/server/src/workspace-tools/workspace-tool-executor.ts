import { randomUUID } from "node:crypto";
import {
  WorkspaceToolRequestSchema,
  WorkspaceToolResultSchema,
  type Session,
  type WorkspaceDiffSummary,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import { MUTATING_WORKSPACE_TOOL_ACTIONS } from "./workspace-tool-action-sets.js";
import { handleActiveWorkspaceToolAction } from "./workspace-tool-active-handlers.js";
import { handleAppWorkspaceToolAction } from "./workspace-tool-app-handlers.js";
import { handleSandboxWorkspaceToolAction } from "./workspace-tool-sandbox-actions.js";
import type { WorkspaceToolExecutorDeps } from "./workspace-tool-executor-types.js";
import { event, textFromUnknown } from "../utils.js";
import { resolveWorkspaceCapabilities, workspaceToolBlockedMessage } from "../workspace/workspace-capabilities.js";
import {
  resolveWorkspaceExecutionTarget,
  type WorkspaceExecutionTarget,
} from "../workspace/workspace-execution-target.js";
import { createCloudSessionReadinessService } from "../workspace/cloud-session-readiness.js";

export type { WorkspaceToolExecutorDeps } from "./workspace-tool-executor-types.js";

function dataWithWorkspaceToolCallId(
  data: unknown,
  workspaceToolCallId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), ...extra, workspaceToolCallId };
  }
  if (data === undefined) return { ...extra, workspaceToolCallId };
  return { value: data, ...extra, workspaceToolCallId };
}

function workspaceToolTiming(input: { startedAtMs: number; completedAtMs?: number }): Record<string, unknown> {
  const startedAt = new Date(input.startedAtMs).toISOString();
  if (typeof input.completedAtMs !== "number") return { startedAt };
  return {
    startedAt,
    completedAt: new Date(input.completedAtMs).toISOString(),
    durationMs: Math.max(0, input.completedAtMs - input.startedAtMs),
  };
}

function workspaceExecutionTargetData(target: WorkspaceExecutionTarget): Record<string, unknown> {
  if (target.target === "sandbox") {
    return {
      target: target.target,
      ready: target.ready,
      workspaceKind: target.workspaceKind,
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      sandboxId: target.sandboxId,
      cloudProjectId: target.cloudProjectId,
      cloudTeamId: target.cloudTeamId,
      localProjectId: target.localProjectId,
      hybrid: target.hybrid,
      reason: target.reason,
    };
  }
  if (target.target === "local") {
    return {
      target: target.target,
      ready: target.ready,
      workspaceKind: target.workspaceKind,
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      localProjectId: target.localProjectId,
      reason: target.reason,
    };
  }
  return {
    target: target.target,
    ready: target.ready,
    workspaceKind: target.workspaceKind,
    workspaceId: target.workspaceId,
    workspaceName: target.workspaceName,
    reason: target.reason,
  };
}

export function createWorkspaceToolExecutor(deps: WorkspaceToolExecutorDeps): {
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null }
  ) => Promise<WorkspaceToolResult>;
  ensureCloudWorkspaceReady: (sessionId: string, payload: unknown) => Promise<unknown>;
  closeCloudWorkspaceReadiness: () => Promise<void>;
} {
  const {
    logger,
    truncateLogValue,
    appendRuntimeEvent,
    appendWorkspaceDiffEvent,
    getSession,
    updateSession,
    findLocalWorkspace,
    refreshLocalProjectWorkspace,
    linkLocalProjectOpenPondApp,
    activeWorkspace,
    withWorkspaceLock,
    runPostEditChecks,
    runPostEditWorkflow,
    openPondCacheScope,
    upsertScaffoldApp,
    gitBaseUrlFromContext,
  } = deps;

  async function executeWorkspaceTool(
    sessionId: string,
    payload: unknown,
    options: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null } = {}
  ): Promise<WorkspaceToolResult> {
    const workspaceToolCallId = randomUUID();
    const workspaceToolStartedAt = Date.now();
    let input: WorkspaceToolRequest;
    try {
      input = WorkspaceToolRequestSchema.parse(payload);
    } catch (error) {
      logger.warn("workspace tool call rejected", {
        workspaceToolCallId,
        sessionId,
        turnId: options.turnId,
        durationMs: Date.now() - workspaceToolStartedAt,
        error,
        payload: truncateLogValue(payload),
      });
      throw error;
    }
    logger.info("workspace tool call received", {
      workspaceToolCallId,
      sessionId,
      turnId: options.turnId,
      source: input.source,
      action: input.action,
      args: truncateLogValue(input.args),
    });
    let session: Session;
    try {
      session = await getSession(sessionId);
    } catch (error) {
      logger.warn("workspace tool call finished", {
        workspaceToolCallId,
        sessionId,
        turnId: options.turnId,
        source: input.source,
        action: input.action,
        status: "failed",
        durationMs: Date.now() - workspaceToolStartedAt,
        error,
      });
      throw error;
    }
    const startedAppId = session.appId;
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId: options.turnId,
        name: "workspace_action",
        source: input.source,
        action: input.action,
        appId: startedAppId,
        args: input.args,
        status: "started",
        data: dataWithWorkspaceToolCallId(undefined, workspaceToolCallId, {
          workspaceToolTiming: workspaceToolTiming({ startedAtMs: workspaceToolStartedAt }),
        }),
      })
    );
    const reportWorkspaceProgress = async (progress: {
      action?: string;
      status?: "started" | "completed" | "failed" | "pending";
      output?: string;
      data?: unknown;
    }): Promise<void> => {
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: options.turnId,
          name: "workspace_action",
          source: input.source,
          action: progress.action ?? input.action,
          appId: startedAppId,
          status: progress.status ?? "pending",
          output: progress.output,
          data: dataWithWorkspaceToolCallId(progress.data, workspaceToolCallId, {
            workspaceToolTiming: workspaceToolTiming({ startedAtMs: workspaceToolStartedAt }),
          }),
        })
      );
    };
  
    let executionTarget: WorkspaceExecutionTarget | null = null;
    try {
      let result: WorkspaceToolResult;
      const localProjectId =
        session.workspaceKind === "local_project" && session.workspaceId
          ? session.workspaceId
          : session.localProjectId ?? null;
      const localProject = localProjectId ? await findLocalWorkspace(localProjectId) : null;
      executionTarget = resolveWorkspaceExecutionTarget({ session, localProject });
      const capabilities = resolveWorkspaceCapabilities({ session, localProject });
      const blockedMessage = workspaceToolBlockedMessage({
        action: input.action,
        session,
        localProject,
        capabilities,
      });
      if (blockedMessage) throw new Error(blockedMessage);

      const appAction = await handleAppWorkspaceToolAction({
        input,
        session,
        reportProgress: reportWorkspaceProgress,
        gitBaseUrlFromContext,
        findLocalWorkspace,
        linkLocalProjectOpenPondApp,
        openPondCacheScope,
        updateSession,
        upsertScaffoldApp,
      });
      if (appAction) {
        session = appAction.session;
        result = appAction.result;
      } else {
        const sandboxAction = await handleSandboxWorkspaceToolAction({
          request: input,
          session,
          updateSession,
          findLocalWorkspace,
        });
        if (sandboxAction) {
          result = sandboxAction;
        } else {
          const { app, state } = await activeWorkspace(session);
          const activeCapabilities = resolveWorkspaceCapabilities({ session, localProject, state });
          const activeBlockedMessage = workspaceToolBlockedMessage({
            action: input.action,
            session,
            localProject,
            state,
            capabilities: activeCapabilities,
          });
          if (activeBlockedMessage) throw new Error(activeBlockedMessage);
          result = await handleActiveWorkspaceToolAction({
            app,
            input,
            session,
            state,
            turnId: options.turnId,
            refreshLocalProjectWorkspace,
            withWorkspaceLock,
            runPostEditChecks,
            runPostEditWorkflow,
          });
        }
      }
  
      const resultSession = await getSession(sessionId).catch(() => session);
      const resultLocalProjectId =
        resultSession.workspaceKind === "local_project" && resultSession.workspaceId
          ? resultSession.workspaceId
          : resultSession.localProjectId ?? null;
      const resultLocalProject = resultLocalProjectId
        ? await findLocalWorkspace(resultLocalProjectId).catch(() => localProject)
        : null;
      const resultExecutionTarget = resolveWorkspaceExecutionTarget({
        session: resultSession,
        localProject: resultLocalProject,
      });
      const workspaceToolCompletedAt = Date.now();
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: options.turnId,
          name: "workspace_action_result",
          source: input.source,
          action: input.action,
          appId: result.appId ?? startedAppId,
          status: result.ok ? "completed" : "failed",
          output: result.output,
          error: result.ok ? undefined : result.output,
          data: dataWithWorkspaceToolCallId(result.data, workspaceToolCallId, {
            workspaceExecutionTarget: workspaceExecutionTargetData(resultExecutionTarget),
            workspaceToolTiming: workspaceToolTiming({
              startedAtMs: workspaceToolStartedAt,
              completedAtMs: workspaceToolCompletedAt,
            }),
          }),
        })
      );
      if (
        !result.ok &&
        input.action === "sandbox_create" &&
        session.workspaceKind === "sandbox" &&
        !session.workspaceId
      ) {
        await updateSession(session.id, { status: "failed" });
      }
      if (
        options.turnId &&
        MUTATING_WORKSPACE_TOOL_ACTIONS.includes(input.action as (typeof MUTATING_WORKSPACE_TOOL_ACTIONS)[number]) &&
        result.data
      ) {
        await appendWorkspaceDiffEvent(
          await getSession(sessionId),
          options.turnId,
          options.workspaceDiffBaseline === undefined
            ? undefined
            : { baseline: options.workspaceDiffBaseline }
        );
      }
      logger[result.ok ? "info" : "warn"]("workspace tool call finished", {
        workspaceToolCallId,
        sessionId,
        turnId: options.turnId,
        source: input.source,
        action: input.action,
        appId: result.appId ?? startedAppId,
        status: result.ok ? "completed" : "failed",
        durationMs: Date.now() - workspaceToolStartedAt,
        output: result.output,
        error: result.ok ? undefined : result.output,
      });
      return result;
    } catch (error) {
      const message = textFromUnknown(error);
      if (
        input.action === "sandbox_create" &&
        session.workspaceKind === "sandbox" &&
        !session.workspaceId
      ) {
        await updateSession(session.id, { status: "failed" });
      }
      const result = WorkspaceToolResultSchema.parse({
        ok: false,
        action: input.action,
        appId: startedAppId,
        output: message,
      });
      const workspaceToolCompletedAt = Date.now();
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: options.turnId,
          name: "workspace_action_result",
          source: input.source,
          action: input.action,
          appId: startedAppId,
          status: "failed",
          output: message,
          error: message,
          data: dataWithWorkspaceToolCallId(undefined, workspaceToolCallId, {
            ...(executionTarget ? { workspaceExecutionTarget: workspaceExecutionTargetData(executionTarget) } : {}),
            workspaceToolTiming: workspaceToolTiming({
              startedAtMs: workspaceToolStartedAt,
              completedAtMs: workspaceToolCompletedAt,
            }),
          }),
        })
      );
      logger.warn("workspace tool call finished", {
        workspaceToolCallId,
        sessionId,
        turnId: options.turnId,
        source: input.source,
        action: input.action,
        appId: startedAppId,
        status: "failed",
        durationMs: Date.now() - workspaceToolStartedAt,
        output: message,
        error: message,
      });
      return result;
    }
  }

  const {
    close: closeCloudWorkspaceReadiness,
    ensureReady: ensureCloudWorkspaceReady,
  } = createCloudSessionReadinessService({
    getSession,
    executeWorkspaceTool,
    sandboxRequest: deps.sandboxRequest,
  });
  return { closeCloudWorkspaceReadiness, ensureCloudWorkspaceReady, executeWorkspaceTool };
}
