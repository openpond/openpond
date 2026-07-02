import type { Dispatch, SetStateAction } from "react";
import type {
  AppPreferences,
  BootstrapPayload,
  ChatProvider,
  LocalProject,
  LocalProjectOpenPondLink,
  OpenPondApp,
  Session,
  WorkspaceDiffSummary,
  WorkspaceState,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { AppAction } from "../app/app-state";
import type { CommitNextStep } from "../components/workspace/WorkspaceGitDialogs";
import { modelRefForTurn, normalizeBranchPrefix, projectSelectionKey } from "../lib/app-models";
import type { AppView, SettingsSection } from "../lib/app-models";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";

type ShowToast = (
  message: string,
  tone?: "success" | "error" | "info",
  options?: {
    actionLabel?: string;
    onAction?: () => void;
    persistent?: boolean;
  }
) => void;

type UseWorkspaceActionsInput = {
  connection: ClientConnection | null;
  activeWorkspaceAppId: string | null | undefined;
  appDefaults: AppPreferences;
  bootstrap: BootstrapPayload | null;
  branchDialogName: string;
  commitIncludeUnstaged: boolean;
  commitMessage: string;
  commitNextStep: CommitNextStep;
  draftModel: string;
  draftProvider: ChatProvider;
  selectedApp: OpenPondApp | null;
  selectedProject: LocalProject | null;
  selectedProjectLinkedOpenPondApp: LocalProjectOpenPondLink | null;
  selectedSession: Session | null;
  sessions: Session[];
  title: string;
  visibleWorkspaceDiff: WorkspaceDiffSummary | null;
  visibleWorkspaceState: WorkspaceState | null;
  workspaceBusy: boolean;
  workspaceName: string | null;
  appDispatch: Dispatch<AppAction>;
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  expandProject: (projectId: string) => void;
  refreshWorkspace: (appId: string | null | undefined, ensure?: boolean) => Promise<WorkspaceState | null>;
  refreshWorkspaceDiff: (appId?: string | null | undefined) => Promise<WorkspaceDiffSummary | null>;
  rememberWorkspaceState: (state: WorkspaceState) => void;
  setBranchDialogOpen: Dispatch<SetStateAction<boolean>>;
  setCommitDialogOpen: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setSettingsSection: Dispatch<SetStateAction<SettingsSection>>;
  setSyncingWorkspaceAppId: Dispatch<SetStateAction<string | null>>;
  setView: Dispatch<SetStateAction<AppView>>;
  setWorkspaceBusy: Dispatch<SetStateAction<boolean>>;
  showToast: ShowToast;
};

function slugForBranch(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "new-branch"
  );
}

export function useWorkspaceActions({
  connection,
  activeWorkspaceAppId,
  appDefaults,
  bootstrap,
  branchDialogName,
  commitIncludeUnstaged,
  commitMessage,
  commitNextStep,
  draftModel,
  draftProvider,
  selectedApp,
  selectedProject,
  selectedProjectLinkedOpenPondApp,
  selectedSession,
  sessions,
  title,
  visibleWorkspaceDiff,
  visibleWorkspaceState,
  workspaceBusy,
  workspaceName,
  appDispatch,
  applyBootstrapPayload,
  expandProject,
  refreshWorkspace,
  refreshWorkspaceDiff,
  rememberWorkspaceState,
  setBranchDialogOpen,
  setCommitDialogOpen,
  setError,
  setSessions,
  setSettingsSection,
  setSyncingWorkspaceAppId,
  setView,
  setWorkspaceBusy,
  showToast,
}: UseWorkspaceActionsInput) {
  function defaultBranchName(): string {
    return `${normalizeBranchPrefix(appDefaults.defaultBranchPrefix)}${slugForBranch(workspaceName ?? title ?? "new-branch")}`;
  }

  function defaultCommitMessage(): string {
    if (workspaceName) return `Update ${workspaceName}`;
    const count = visibleWorkspaceDiff?.filesChanged ?? visibleWorkspaceState?.changedFilesCount ?? 0;
    return count === 1 ? "Update workspace file" : "Update workspace files";
  }

  function openCommitDialog(nextStep: CommitNextStep = "commit") {
    appDispatch({ type: "openCommitDialog", nextStep });
  }

  function openCreateWorkspaceBranchDialog() {
    appDispatch({ type: "openBranchDialog", branchName: defaultBranchName() });
  }

  function openDefaultsSettingsFromBranchDialog() {
    if (!workspaceBusy) setBranchDialogOpen(false);
    setSettingsSection("defaults");
    setView("settings");
  }

  async function changeWorkspaceBranch(branch: string) {
    if (!connection || !activeWorkspaceAppId) return;
    setWorkspaceBusy(true);
    setError(null);
    try {
      const state = await api.checkoutWorkspaceBranch(connection, activeWorkspaceAppId, { branch });
      rememberWorkspaceState(state);
      if (state.initialized) void refreshWorkspaceDiff(activeWorkspaceAppId);
    } catch (branchError) {
      setError(branchError instanceof Error ? branchError.message : String(branchError));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function submitCreateWorkspaceBranch() {
    if (!connection || !activeWorkspaceAppId) return;
    const trimmed = branchDialogName.trim();
    if (!trimmed) return;
    setWorkspaceBusy(true);
    setError(null);
    try {
      const state = await api.createWorkspaceBranch(connection, activeWorkspaceAppId, { branch: trimmed });
      rememberWorkspaceState(state);
      if (state.initialized) void refreshWorkspaceDiff(activeWorkspaceAppId);
      setBranchDialogOpen(false);
      showToast(`Checked out ${trimmed}`, "success");
    } catch (branchError) {
      setError(branchError instanceof Error ? branchError.message : String(branchError));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function syncWorkspaceLocallyForApp(appId: string) {
    setSyncingWorkspaceAppId(appId);
    const appName =
      bootstrap?.apps.find((app) => app.id === appId)?.name ??
      bootstrap?.localProjects.find((project) => project.id === appId)?.name ??
      "Workspace";
    try {
      const state = await refreshWorkspace(appId, true);
      if (state?.initialized && appId === activeWorkspaceAppId) void refreshWorkspaceDiff(appId);
      if (state?.initialized && !state.error) {
        showToast(`${appName} synced locally`, "success");
      } else if (state?.error) {
        showToast("Workspace sync failed", "error");
      }
    } finally {
      setSyncingWorkspaceAppId((current) => (current === appId ? null : current));
    }
  }

  async function syncWorkspaceLocally() {
    if (!activeWorkspaceAppId) return;
    await syncWorkspaceLocallyForApp(activeWorkspaceAppId);
  }

  async function ensureActionSession(actionTitle: string): Promise<Session | null> {
    if (!connection) return null;
    const selectedWritableSession =
      selectedSession && !isCodexHistorySessionId(selectedSession.id) ? selectedSession : null;
    if (
      selectedWritableSession &&
      selectedSessionMatchesWorkspace(selectedWritableSession, selectedProject, selectedApp)
    ) {
      return selectedWritableSession;
    }
    const reboundSession = selectedWritableSession
      ? await bindSelectedSessionToProjectIfNeeded(selectedWritableSession)
      : null;
    if (reboundSession) return reboundSession;
    const existingSession = findLatestWorkspaceSession(sessions, selectedProject, selectedApp);
    if (existingSession) {
      const projectKey =
        existingSession.workspaceKind === "local_project" && existingSession.workspaceId
          ? projectSelectionKey("local", existingSession.workspaceId)
          : null;
      appDispatch({
        type: "selectSession",
        sessionId: existingSession.id,
        appId: existingSession.appId,
        projectId: projectKey,
      });
      if (existingSession.workspaceKind === "local_project" && existingSession.workspaceId) {
        expandProject(projectSelectionKey("local", existingSession.workspaceId));
      }
      return existingSession;
    }
    const session = await api.createSession(connection, {
      provider: draftProvider,
      modelRef: modelRefForTurn(draftProvider, draftModel, bootstrap?.providers ?? null),
      appId: selectedProjectLinkedOpenPondApp?.appId ?? selectedApp?.id ?? null,
      appName: selectedProjectLinkedOpenPondApp?.appName ?? selectedApp?.name ?? null,
      workspaceKind: selectedProject ? "local_project" : selectedApp ? "sandbox_app" : undefined,
      workspaceId: selectedProject?.id ?? selectedApp?.id ?? null,
      workspaceName: selectedProject?.name ?? selectedApp?.name ?? null,
      localProjectId: selectedProject?.id ?? null,
      cloudProjectId: selectedProject?.linkedSandboxProject?.projectId ?? null,
      cloudTeamId: selectedProject?.linkedSandboxProject?.teamId ?? null,
      cwd: selectedProject ? selectedProject.workspacePath : null,
      title: actionTitle,
    });
    setSessions((current) => [session, ...current]);
    const projectKey =
      session.workspaceKind === "local_project" && session.workspaceId
        ? projectSelectionKey("local", session.workspaceId)
        : null;
    appDispatch({
      type: "selectSession",
      sessionId: session.id,
      appId: session.appId,
      projectId: projectKey,
    });
    if (session.workspaceKind === "local_project" && session.workspaceId) {
      expandProject(projectSelectionKey("local", session.workspaceId));
    }
    return session;
  }

  async function bindSelectedSessionToProjectIfNeeded(session: Session): Promise<Session | null> {
    if (!connection || !selectedProject || !selectedProjectLinkedOpenPondApp?.appId) return null;
    if (isCodexHistorySessionId(session.id)) return null;
    if (session.workspaceKind === "local_project" || session.appId !== selectedProjectLinkedOpenPondApp.appId) {
      return null;
    }
    const updated = await api.patchSession(connection, session.id, {
      appId: selectedProjectLinkedOpenPondApp.appId,
      appName: selectedProjectLinkedOpenPondApp.appName,
      workspaceKind: "local_project",
      workspaceId: selectedProject.id,
      workspaceName: selectedProject.name,
      localProjectId: selectedProject.id,
      cloudProjectId: selectedProject.linkedSandboxProject?.projectId ?? null,
      cloudTeamId: selectedProject.linkedSandboxProject?.teamId ?? null,
      cwd: selectedProject.workspacePath,
    });
    setSessions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    appDispatch({
      type: "selectSession",
      sessionId: updated.id,
      appId: updated.appId,
      projectId: projectSelectionKey("local", selectedProject.id),
    });
    expandProject(projectSelectionKey("local", selectedProject.id));
    return updated;
  }

  async function performWorkspaceTool(
    action: WorkspaceToolRequest["action"],
    args: Record<string, unknown> = {}
  ): Promise<WorkspaceToolResult | null> {
    if (!connection) return null;
    const session = await ensureActionSession(workspaceName ? `${workspaceName} workspace` : "Workspace action");
    if (!session) return null;
    const result = await api.workspaceTool(connection, session.id, {
      action,
      args,
      source: "ui_button",
    });
    showToast(result.output, result.ok ? "success" : "error");
    applyBootstrapPayload(await api.bootstrap(connection));
    const workspaceId = session.workspaceId ?? session.appId;
    if (workspaceId) {
      const state = await refreshWorkspace(workspaceId, false);
      if (state?.initialized) await refreshWorkspaceDiff(workspaceId);
    }
    return result;
  }

  async function runWorkspaceTool(
    action: WorkspaceToolRequest["action"],
    args: Record<string, unknown> = {}
  ): Promise<WorkspaceToolResult | null> {
    if (action === "git_commit" && typeof args.message !== "string") {
      openCommitDialog("commit");
      return null;
    }
    setWorkspaceBusy(true);
    setError(null);
    try {
      return await performWorkspaceTool(action, args);
    } catch (toolError) {
      setError(toolError instanceof Error ? toolError.message : String(toolError));
      return null;
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function submitCommitDialog() {
    const message = commitMessage.trim() || defaultCommitMessage();
    const publishAfterCommit = commitNextStep === "commit_publish";
    const replaceOriginForPublish = publishAfterCommit && Boolean(visibleWorkspaceState?.remoteUrl);
    if (
      replaceOriginForPublish &&
      !window.confirm("Replace the current origin remote with the new OpenPond repo after committing?")
    ) {
      return;
    }
    setWorkspaceBusy(true);
    setError(null);
    try {
      const commit = await performWorkspaceTool("git_commit", {
        message,
        includeUnstaged: commitIncludeUnstaged,
      });
      if (!commit?.ok) return;
      if (commitNextStep === "commit_push") {
        const push = await performWorkspaceTool("git_push", { runChecks: false });
        if (!push?.ok) return;
      }
      if (publishAfterCommit) {
        const publish = await performWorkspaceTool("publish_openpond_repo", { replaceOrigin: replaceOriginForPublish });
        if (!publish?.ok) return;
      }
      setCommitDialogOpen(false);
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : String(commitError));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  return {
    changeWorkspaceBranch,
    openCommitDialog,
    openCreateWorkspaceBranchDialog,
    openDefaultsSettingsFromBranchDialog,
    runWorkspaceTool,
    submitCommitDialog,
    submitCreateWorkspaceBranch,
    syncWorkspaceLocally,
    syncWorkspaceLocallyForApp,
  };
}

function selectedSessionMatchesWorkspace(
  session: Session,
  selectedProject: LocalProject | null,
  selectedApp: OpenPondApp | null,
): boolean {
  if (!selectedProject && !selectedApp) return true;
  return workspaceSelectionMatchesSession(session, selectedProject, selectedApp);
}

function findLatestWorkspaceSession(
  sessions: Session[],
  selectedProject: LocalProject | null,
  selectedApp: OpenPondApp | null,
): Session | null {
  if (!selectedProject && !selectedApp) return null;
  let best: Session | null = null;
  let bestUpdatedAt = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    if (session.archived || !workspaceSelectionMatchesSession(session, selectedProject, selectedApp)) continue;
    const updatedAt = Date.parse(session.updatedAt);
    const timestamp = Number.isFinite(updatedAt) ? updatedAt : 0;
    if (!best || timestamp > bestUpdatedAt) {
      best = session;
      bestUpdatedAt = timestamp;
    }
  }
  return best;
}

function workspaceSelectionMatchesSession(
  session: Session,
  selectedProject: LocalProject | null,
  selectedApp: OpenPondApp | null,
): boolean {
  if (selectedProject) {
    return session.workspaceKind === "local_project" && session.workspaceId === selectedProject.id;
  }
  if (selectedApp) {
    return session.appId === selectedApp.id || session.workspaceId === selectedApp.id;
  }
  return false;
}
