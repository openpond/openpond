import path from "node:path";

import {
  WorkspaceToolRequestSchema,
  WorkspaceToolResultSchema,
  localPathWorkspaceId,
  type LocalProject,
  type OpenPondApp,
  type RuntimeEvent,
  type Session,
  type WorkspaceDiffSummary,
  type WorkspaceState,
  type WorkspaceToolResult,
} from "@openpond/contracts";

import { event, textFromUnknown } from "../utils.js";
import { loadWorkspaceDiffAtPath } from "../workspace/workspace-diff.js";
import { loadWorkspaceStateAtPath } from "../workspace/workspaces.js";
import { handleActiveWorkspaceToolAction } from "../workspace-tools/workspace-tool-active-handlers.js";
import { MUTATING_WORKSPACE_TOOL_ACTIONS } from "../workspace-tools/workspace-tool-action-sets.js";

type AppServerWorkspaceLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
};

export function createAppServerWorkspace(input: {
  workspaceDir: string;
  logger: AppServerWorkspaceLogger;
  getSession(sessionId: string): Promise<Session>;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
}) {
  const workspaceDir = path.resolve(input.workspaceDir);
  const locks = new Map<string, Promise<unknown>>();

  async function workspaceForSession(
    session: Session,
  ): Promise<{ app: OpenPondApp; state: WorkspaceState }> {
    const repoPath = path.resolve(session.cwd?.trim() || workspaceDir);
    const app = workspaceApp(repoPath, session.updatedAt);
    const state = await loadWorkspaceStateAtPath(
      { workspacePath: repoPath, repoPath },
      app,
      { clone: false, allowPlainFolder: true },
    );
    if (!state.initialized) {
      throw new Error(state.error || `App-server workspace is unavailable: ${repoPath}`);
    }
    return { app, state };
  }

  async function workspaceDiffBaseline(
    session: Session,
  ): Promise<WorkspaceDiffSummary | null> {
    try {
      const { app, state } = await workspaceForSession(session);
      return await loadWorkspaceDiffAtPath(state.repoPath, app.id, {
        includeFileDetails: true,
      });
    } catch {
      return null;
    }
  }

  async function appendWorkspaceDiffEvent(
    session: Session,
    turnId: string,
    options: { baseline?: WorkspaceDiffSummary | null } = {},
  ): Promise<void> {
    const { app, state } = await workspaceForSession(session);
    const summary = await loadWorkspaceDiffAtPath(state.repoPath, app.id, {
      includeFileDetails: true,
    });
    const baseline = options.baseline;
    if (!summary.dirty || (baseline && sameDiff(summary, baseline))) return;
    await input.appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "workspace.diff",
        source: "server",
        appId: session.appId ?? app.id,
        status: "completed",
        data: summary,
      }),
    );
  }

  async function executeWorkspaceTool(
    sessionId: string,
    payload: unknown,
    options: {
      turnId?: string;
      workspaceDiffBaseline?: WorkspaceDiffSummary | null;
    } = {},
  ): Promise<WorkspaceToolResult> {
    const request = WorkspaceToolRequestSchema.parse(payload);
    const session = await input.getSession(sessionId);
    const startedAt = Date.now();
    await input.appendRuntimeEvent(
      event({
        sessionId,
        turnId: options.turnId,
        name: "workspace_action",
        source: request.source,
        action: request.action,
        appId: session.appId,
        args: request.args,
        status: "started",
      }),
    );

    try {
      if (request.action.startsWith("sandbox_")) {
        throw new Error(
          "Nested sandbox operations are not available inside the app-server placement.",
        );
      }
      const { app, state } = await workspaceForSession(session);
      const result = await handleActiveWorkspaceToolAction({
        app,
        input: request,
        session,
        state,
        turnId: options.turnId,
        withWorkspaceLock,
        refreshLocalProjectWorkspace: unavailableLocalProject,
        runPostEditChecks: async () => [],
        runPostEditWorkflow: async () => ({
          ok: true,
          checks: [],
          managed: null,
        }),
      });
      await recordResult(session, result, options.turnId, startedAt);
      if (
        options.turnId &&
        MUTATING_WORKSPACE_TOOL_ACTIONS.includes(
          request.action as (typeof MUTATING_WORKSPACE_TOOL_ACTIONS)[number],
        )
      ) {
        await appendWorkspaceDiffEvent(session, options.turnId, {
          baseline: options.workspaceDiffBaseline,
        });
      }
      return result;
    } catch (error) {
      const result = WorkspaceToolResultSchema.parse({
        ok: false,
        action: request.action,
        appId: session.appId,
        output: textFromUnknown(error),
      });
      await recordResult(session, result, options.turnId, startedAt);
      return result;
    }
  }

  async function recordResult(
    session: Session,
    result: WorkspaceToolResult,
    turnId: string | undefined,
    startedAt: number,
  ): Promise<void> {
    await input.appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "workspace_action_result",
        source: "chat_action",
        action: result.action,
        appId: result.appId ?? session.appId,
        status: result.ok ? "completed" : "failed",
        output: result.output,
        error: result.ok ? undefined : result.output,
        data: {
          result: result.data,
          placement: "hosted_work",
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      }),
    );
    input.logger[result.ok ? "info" : "warn"]("app-server workspace tool finished", {
      sessionId: session.id,
      turnId,
      action: result.action,
      ok: result.ok,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }

  async function withWorkspaceLock<T>(
    workspaceId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (locks.has(workspaceId)) throw new Error("Workspace is busy.");
    const pending = work();
    locks.set(workspaceId, pending);
    try {
      return await pending;
    } finally {
      if (locks.get(workspaceId) === pending) locks.delete(workspaceId);
    }
  }

  async function unavailableLocalProject(): Promise<LocalProject> {
    throw new Error("Local project registry is not part of app-server placement.");
  }

  return {
    appendWorkspaceDiffEvent,
    executeWorkspaceTool,
    workspaceDiffBaseline,
    workspaceForSession,
  };
}

function workspaceApp(repoPath: string, updatedAt: string): OpenPondApp {
  return {
    id: localPathWorkspaceId(repoPath),
    name: path.basename(repoPath) || "Sandbox workspace",
    description: null,
    visibility: "private",
    gitOwner: null,
    gitRepo: null,
    gitHost: null,
    defaultBranch: null,
    sandbox: false,
    updatedAt,
    latestDeployment: null,
  };
}

function sameDiff(
  current: WorkspaceDiffSummary,
  baseline: WorkspaceDiffSummary,
): boolean {
  return JSON.stringify(current.files) === JSON.stringify(baseline.files);
}
