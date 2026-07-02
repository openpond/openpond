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

export type { WorkspaceToolExecutorDeps } from "./workspace-tool-executor-types.js";

function dataWithWorkspaceToolCallId(data: unknown, workspaceToolCallId: string): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), workspaceToolCallId };
  }
  if (data === undefined) return { workspaceToolCallId };
  return { value: data, workspaceToolCallId };
}

export function createWorkspaceToolExecutor(deps: WorkspaceToolExecutorDeps): {
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null }
  ) => Promise<WorkspaceToolResult>;
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
        data: dataWithWorkspaceToolCallId(undefined, workspaceToolCallId),
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
          data: dataWithWorkspaceToolCallId(progress.data, workspaceToolCallId),
        })
      );
    };
  
    try {
      let result: WorkspaceToolResult;
      const localProject =
        session.workspaceKind === "local_project" && session.workspaceId
          ? await findLocalWorkspace(session.workspaceId)
          : null;
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
          data: dataWithWorkspaceToolCallId(result.data, workspaceToolCallId),
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
          data: dataWithWorkspaceToolCallId(undefined, workspaceToolCallId),
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

  return { executeWorkspaceTool };
}
