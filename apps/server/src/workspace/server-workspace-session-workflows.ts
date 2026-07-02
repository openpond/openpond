import {
  WorkspaceDiffSummarySchema,
  WorkspaceStateSchema,
  type LocalProject,
  type OpenPondApp,
  type RuntimeEvent,
  type Session,
  type WorkspaceDiffFile,
  type WorkspaceDiffSummary,
  type WorkspaceState,
} from "@openpond/contracts";
import { localProjectStateWorkspace, localProjectWorkspaceApp, localProjectWorkspacePaths } from "./local-projects.js";
import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import { event, textFromUnknown } from "../utils.js";
import { loadWorkspaceState, loadWorkspaceStateAtPath } from "./workspaces.js";

export function createWorkspaceSessionWorkflows(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  checkpointDiffQueue: BackgroundWorkerQueue;
  findLocalWorkspace: (projectId: string) => Promise<LocalProject | null>;
  findOpenPondApp: (appId: string) => Promise<OpenPondApp>;
  storeDir: string;
  workspaceDiffPayload: (
    appId: string,
    options?: { includeFileDetails?: boolean },
  ) => Promise<WorkspaceDiffSummary>;
}) {
  const {
    appendRuntimeEvent,
    checkpointDiffQueue,
    findLocalWorkspace,
    findOpenPondApp,
    storeDir,
    workspaceDiffPayload,
  } = deps;

  async function activeWorkspace(session: Session): Promise<{ app: OpenPondApp; state: WorkspaceState }> {
    if (session.workspaceKind === "local_project") {
      const workspaceId = session.workspaceId;
      if (!workspaceId) throw new Error("No active project workspace");
      const project = await findLocalWorkspace(workspaceId);
      if (!project) throw new Error("Project workspace not found");
      const state = WorkspaceStateSchema.parse(
        await loadWorkspaceStateAtPath(
          localProjectWorkspacePaths(project),
          localProjectStateWorkspace(project),
          { clone: false, allowPlainFolder: true }
        )
      );
      if (!state.initialized) throw new Error(state.error || "Workspace is not initialized");
      return { app: localProjectWorkspaceApp(project), state };
    }
    if (!session.appId) throw new Error("No active app workspace");
    const app = await findOpenPondApp(session.appId);
    const state = WorkspaceStateSchema.parse(await loadWorkspaceState(storeDir, app, { clone: false }));
    if (!state.initialized) throw new Error(state.error || "Workspace is not initialized");
    return { app, state };
  }

  async function workspaceDiffBaseline(session: Session): Promise<WorkspaceDiffSummary | null> {
    const workspaceId = workspaceIdForSession(session);
    if (!workspaceId) return null;
    try {
      return WorkspaceDiffSummarySchema.parse(await workspaceDiffPayload(workspaceId, { includeFileDetails: true }));
    } catch {
      return null;
    }
  }

  async function appendWorkspaceDiffEvent(
    session: Session,
    turnId: string,
    options: { baseline?: WorkspaceDiffSummary | null } = {}
  ): Promise<void> {
    const workspaceId = workspaceIdForSession(session);
    if (!workspaceId) return;
    checkpointDiffQueue.enqueue(
      {
        label: "Workspace diff event capture",
        metadata: {
          sessionId: session.id,
          turnId,
          workspaceId,
        },
      },
      () => captureWorkspaceDiffEvent(session, turnId, workspaceId, options),
    );
  }

  async function captureWorkspaceDiffEvent(
    session: Session,
    turnId: string,
    workspaceId: string,
    options: { baseline?: WorkspaceDiffSummary | null } = {}
  ): Promise<void> {
    try {
      const summary = WorkspaceDiffSummarySchema.parse(
        await workspaceDiffPayload(workspaceId, { includeFileDetails: true })
      );
      const eventSummary = "baseline" in options ? workspaceDiffSinceBaseline(summary, options.baseline ?? null) : summary;
      if (!eventSummary || !eventSummary.dirty || eventSummary.filesChanged === 0) return;
      await appendRuntimeEvent(
        event({
          sessionId: session.id,
          turnId,
          name: "workspace.diff",
          source: "server",
          appId: session.appId ?? workspaceId,
          status: "completed",
          data: eventSummary,
        })
      );
    } catch (error) {
      try {
        await appendRuntimeEvent(
          event({
            sessionId: session.id,
            turnId,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "failed",
            output: `Workspace diff capture failed: ${textFromUnknown(error)}`,
          })
        );
      } catch {
        // Diff capture must not change the provider turn outcome.
      }
    }
  }

  return { activeWorkspace, appendWorkspaceDiffEvent, workspaceDiffBaseline };
}

function workspaceIdForSession(session: Pick<Session, "workspaceId" | "appId">): string | null {
  return session.workspaceId ?? session.appId ?? null;
}

export function workspaceDiffSinceBaseline(
  current: WorkspaceDiffSummary,
  baseline: WorkspaceDiffSummary | null
): WorkspaceDiffSummary | null {
  if (!current.dirty || current.filesChanged === 0) return null;
  if (!baseline) return current;

  const baselineSignatures = new Map(baseline.files.map((file) => [file.path, workspaceDiffFileSignature(file)]));
  const files = current.files.filter((file) => baselineSignatures.get(file.path) !== workspaceDiffFileSignature(file));
  if (files.length === 0) return null;

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return {
    ...current,
    dirty: true,
    filesChanged: files.length,
    additions,
    deletions,
    files,
  };
}

function workspaceDiffFileSignature(file: WorkspaceDiffFile): string {
  return JSON.stringify([file.status, file.additions, file.deletions, file.patch, file.content ?? null]);
}
