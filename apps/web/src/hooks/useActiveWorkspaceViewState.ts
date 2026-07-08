import { useMemo } from "react";
import { localPathWorkspaceId } from "@openpond/contracts";
import type {
  BootstrapPayload,
  ChatProvider,
  CloudProject,
  LocalProject,
  OpenPondApp,
  Session,
  WorkspaceState,
  WorkspaceKind,
} from "@openpond/contracts";
import type { ComposerProjectTargetState } from "../components/chat/Composer";
import { normalizeChatModel, normalizePreferences } from "../lib/app-models";
import {
  cloudWorkspaceStateNote,
  localWorkspaceStateNote,
  uploadSyncStateNote,
} from "../lib/project-workflow-state";
import { confirmedLinkedCloudProject } from "../lib/cloud-link-trust";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import {
  isHybridWorkspaceSession,
  isCloudWorkspaceKind,
  isPendingCloudStartSession,
  type WorkspaceLocation,
  type WorkspaceTargetOptionState,
  type WorkspaceTargetState,
} from "../lib/workspace-location";

export function useActiveWorkspaceViewState({
  bootstrap,
  draftModel,
  draftProvider,
  selectedApp,
  selectedAppId,
  selectedCloudProject,
  selectedProject,
  selectedSession,
  selectedSessionId,
  selectedSessionLinkedProject,
}: {
  bootstrap: BootstrapPayload | null;
  draftModel: string;
  draftProvider: ChatProvider;
  selectedApp: OpenPondApp | null;
  selectedAppId: string | null;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  selectedSession: Session | null;
  selectedSessionId: string | null;
  selectedSessionLinkedProject: LocalProject | null;
}) {
  const selectedSessionProjectId =
    selectedSession?.workspaceKind === "local_project"
      ? (selectedSession.workspaceId ?? null)
      : (selectedSessionLinkedProject?.id ?? null);
  const selectedCodexHistoryPending = isCodexHistorySessionId(selectedSessionId) && !selectedSession;
  const selectedSessionCloudWorkspace = selectedSession
    ? isCloudWorkspaceKind(selectedSession.workspaceKind)
    : false;
  const selectedSessionHybridWorkspace = isHybridWorkspaceSession(selectedSession);
  const selectedSessionPendingCloudStart = selectedSession
    ? isPendingCloudStartSession(selectedSession)
    : false;
  const selectedSessionCodexWorkspaceId =
    selectedSession?.provider === "codex" && selectedSession.cwd && !selectedSessionCloudWorkspace
      ? localPathWorkspaceId(selectedSession.cwd)
      : null;
  const providerSettings = bootstrap?.providers ?? null;
  const selectedProjectConfirmedCloudProject = confirmedLinkedCloudProject(
    selectedProject,
    bootstrap?.cloudProjects ?? [],
  );
  const activeProvider =
    selectedSession?.modelRef?.providerId ??
    selectedSession?.provider ??
    (selectedCloudProject ? "openpond" : draftProvider);
  const activeModel =
    selectedSession?.modelRef?.modelId ??
    normalizeChatModel(activeProvider, draftModel, providerSettings);
  const appDefaults = normalizePreferences(bootstrap?.preferences);
  const activeWorkspaceKind: WorkspaceKind | null = selectedCodexHistoryPending
    ? null
    : selectedSession
      ? selectedSessionCloudWorkspace
        ? (selectedSession.workspaceKind ?? "sandbox")
        : selectedSessionPendingCloudStart
          ? "sandbox"
          : selectedSessionProjectId
            ? "local_project"
            : selectedSessionCodexWorkspaceId
              ? "local_project"
              : (selectedSession.workspaceKind ?? (selectedSession.appId ? "sandbox_app" : null))
      : selectedCloudProject
        ? "sandbox"
        : selectedProject
          ? "local_project"
          : selectedAppId
            ? "sandbox_app"
            : null;
  const activeWorkspaceAppId = selectedCodexHistoryPending
    ? null
    : selectedSession
      ? (selectedSessionCloudWorkspace && !selectedSessionHybridWorkspace) || selectedSessionPendingCloudStart
        ? null
        : selectedSessionProjectId
          ? selectedSessionProjectId
          : (selectedSessionCodexWorkspaceId ?? selectedSession.workspaceId ?? selectedSession.appId)
      : selectedCloudProject
        ? null
        : (selectedProject?.id ?? selectedAppId);
  const activeWorkspaceId = selectedCodexHistoryPending
    ? null
    : selectedSession
      ? selectedSessionCloudWorkspace
        ? (selectedSession.workspaceId ?? null)
        : selectedSessionPendingCloudStart
          ? null
          : (selectedSessionProjectId ??
              selectedSessionCodexWorkspaceId ??
              selectedSession.workspaceId ??
              selectedSession.appId)
      : selectedCloudProject
        ? null
        : (selectedProject?.id ?? selectedAppId);
  const account = bootstrap?.account ?? null;
  const accountPending =
    !bootstrap || account?.state === "loading" || account?.state === "switching";
  const accountSignedOut = !accountPending && account?.state === "signed_out";
  const accountLabel = accountPending
    ? null
    : accountSignedOut
      ? "Sign in"
      : (account?.label ?? account?.activeProfile?.handle ?? "Account");
  const activeUserHandle = account?.activeProfile?.handle?.trim() ?? "";
  const startMessage = activeUserHandle ? `Welcome, ${activeUserHandle}` : "Welcome";
  const workspaceName =
    selectedSession?.workspaceName ??
    selectedSession?.appName ??
    selectedCloudProject?.name ??
    selectedProject?.name ??
    selectedApp?.name ??
    null;
  const activeWorkspaceLocation: WorkspaceLocation =
    isCloudWorkspaceKind(activeWorkspaceKind) ? "cloud" : "local";
  const localTargetName =
    selectedProject?.name ??
    selectedSessionLinkedProject?.name ??
    (selectedSession?.workspaceKind === "local_project" ? selectedSession.workspaceName : null) ??
    "Local workspace";
  const cloudTargetName =
    (activeWorkspaceLocation === "cloud" ? workspaceName : null) ??
    selectedCloudProject?.name ??
    selectedProjectConfirmedCloudProject?.name ??
    selectedProject?.name ??
    "Cloud workspace";
  const cloudLinked = Boolean(
    selectedCloudProject?.id ||
      selectedProjectConfirmedCloudProject?.id ||
      selectedSession?.cloudProjectId ||
      activeWorkspaceLocation === "cloud",
  );

  return {
    account,
    accountLabel,
    accountPending,
    accountSignedOut,
    activeModel,
    activeProvider,
    activeWorkspaceAppId,
    activeWorkspaceId,
    activeWorkspaceKind,
    activeWorkspaceLocation,
    appDefaults,
    cloudLinked,
    cloudTargetName,
    localTargetName,
    selectedCodexHistoryPending,
    selectedSessionCloudWorkspace,
    selectedSessionCodexWorkspaceId,
    selectedSessionPendingCloudStart,
    selectedSessionProjectId,
    startMessage,
    workspaceName,
  };
}

export function useWorkspaceTargetState({
  accountPending,
  accountSignedOut,
  activeWorkspaceLocation,
  bootstrap,
  busy,
  cloudLinked,
  selectedCloudProject,
  selectedProject,
  selectedSession,
  pendingWorkspaceTarget,
  workspaceStates,
  workspaceBusy,
}: {
  accountPending: boolean;
  accountSignedOut: boolean;
  activeWorkspaceLocation: WorkspaceLocation;
  bootstrap: BootstrapPayload | null;
  busy: boolean;
  cloudLinked: boolean;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  selectedSession: Session | null;
  pendingWorkspaceTarget: "queue_cloud" | "hybrid" | null;
  workspaceStates: Record<string, WorkspaceState>;
  workspaceBusy: boolean;
}) {
  const selectedProjectConfirmedCloudProject = confirmedLinkedCloudProject(
    selectedProject,
    bootstrap?.cloudProjects ?? [],
  );
  const selectedProjectRawCloudLinked = Boolean(selectedProject?.linkedSandboxProject?.projectId);
  const selectedProjectCloudLinkTrusted = !selectedProjectRawCloudLinked || Boolean(selectedProjectConfirmedCloudProject);
  const projectTarget = useMemo<ComposerProjectTargetState>(() => {
    const localOptions = (bootstrap?.localProjects ?? []).map((project) => ({
      value: `local:${project.id}`,
      label: project.name,
      detail: project.workspacePath,
      kind: "local" as const,
    }));
    const cloudOptions = (bootstrap?.cloudProjects ?? []).map((project) => ({
      value: `cloud:${project.id}`,
      label: project.name,
      detail: project.organizationName ?? project.sourceLabel ?? "OpenPond Cloud",
      kind: "cloud" as const,
    }));
    const value = selectedProject
      ? `local:${selectedProject.id}`
      : selectedCloudProject
        ? `cloud:${selectedCloudProject.id}`
        : "none";
    const selectedOption =
      [...localOptions, ...cloudOptions].find((option) => option.value === value) ?? null;
    return {
      value,
      label: selectedOption?.label ?? "Select Project",
      detail: selectedOption?.detail ?? "Choose a project for local or cloud work",
      busy: workspaceBusy || busy,
      options: [
        ...localOptions,
        ...cloudOptions,
        {
          value: "action:add-local-project",
          label: "Add Local Project",
          detail: "Choose a folder on this machine",
          kind: "action" as const,
        },
        {
          value: "none",
          label: "Don't work in a project",
          detail: "General chat without project files",
          kind: "none" as const,
        },
      ],
    };
  }, [bootstrap?.cloudProjects, bootstrap?.localProjects, busy, selectedCloudProject, selectedProject, workspaceBusy]);
  const cloudSetupAvailable = Boolean(cloudLinked || selectedProject);
  const hybridLinked = Boolean(
    selectedCloudProject?.id ||
      selectedProjectConfirmedCloudProject?.id ||
      selectedSession?.cloudProjectId ||
      isHybridWorkspaceSession(selectedSession),
  );
  const selectedLocalWorkspaceState = selectedProject ? workspaceStates[selectedProject.id] ?? null : null;
  const localStateNote = localWorkspaceStateNote(selectedLocalWorkspaceState, {
    branch: selectedProject?.linkedSandboxProject?.defaultBranch ?? null,
    path: selectedProject?.workspacePath ?? selectedSession?.cwd ?? null,
    linkedCloudSourceKnown: selectedProject?.linkedSandboxProject?.projectId && selectedProjectCloudLinkTrusted
      ? Boolean(selectedProject.linkedSandboxProject.lastUploadedCommit) || !selectedLocalWorkspaceState?.headCommit
      : true,
  });
  const cloudStateNote = cloudWorkspaceStateNote(
    selectedProject,
    selectedCloudProject ?? selectedProjectConfirmedCloudProject,
    selectedLocalWorkspaceState,
    { cloudLinkTrusted: selectedProjectCloudLinkTrusted },
  );
  const uploadStateNote = uploadSyncStateNote(selectedProject, selectedLocalWorkspaceState, {
    cloudLinkTrusted: selectedProjectCloudLinkTrusted,
  });
  const workspaceTarget = useMemo<WorkspaceTargetState>(
    () => {
      const localOption = {
        value: "local" as const,
        label: "Local checkout",
        detail: "Use files on this machine. Best for fast chat and local edits.",
        stateNote: localStateNote,
        disabled: !selectedProject && activeWorkspaceLocation !== "local",
        disabledReason: "No linked local workspace.",
      };
      const queueOption = {
        value: "queue_cloud" as const,
        label: "Queue cloud work item",
        detail: "Run the next task in a hosted sandbox. Keeps this chat local.",
        stateNote: cloudLinked ? `will use ${cloudStateNote}` : "upload required",
        disabled: accountPending || accountSignedOut || !cloudLinked,
        disabledReason: accountSignedOut
          ? "Add an OpenPond account before queueing Cloud work."
          : "Upload/sync this Project to Cloud before queueing work.",
      };
      const hybridOption = {
        value: "hybrid" as const,
        label: "Hybrid",
        detail: "Use your selected model with hosted sandbox edits.",
        stateNote: hybridLinked ? cloudStateNote : "upload required",
        disabled: accountPending || accountSignedOut || !hybridLinked,
        disabledReason: accountSignedOut
          ? "Add an OpenPond account before using Hybrid."
          : "Upload/sync this Project to Cloud before using Hybrid.",
      };
      const cloudOption = {
        value: "cloud" as const,
        label: "Cloud workspace",
        detail: "Chat inside the hosted sandbox. Best for cloud-only files, dependencies, or handoff.",
        stateNote: cloudStateNote,
        disabled: accountPending || accountSignedOut || !cloudSetupAvailable,
        disabledReason: accountSignedOut
          ? "Add an OpenPond account before using Cloud."
          : "Select a Project before Cloud coding.",
      };
      const uploadOption = {
        value: "upload_cloud" as const,
        label: "Upload/sync to cloud",
        detail: "Push local source to OpenPond Git before cloud work.",
        stateNote: uploadStateNote,
        disabled: accountPending || accountSignedOut || !selectedProject,
        disabledReason: accountSignedOut
          ? "Add an OpenPond account before uploading source."
          : "Select a local Project before uploading source.",
      };
      const actionTarget = activeWorkspaceLocation === "cloud" ? "local" : "cloud";
      const actionOption = actionTarget === "local" ? localOption : cloudOption;
      let selectedOption: WorkspaceTargetOptionState =
        activeWorkspaceLocation === "cloud" ? cloudOption : localOption;
      if (pendingWorkspaceTarget === "queue_cloud") selectedOption = queueOption;
      if (isHybridWorkspaceSession(selectedSession) || pendingWorkspaceTarget === "hybrid") {
        selectedOption = hybridOption;
      }
      return {
        value: selectedOption.value,
        label: selectedOption.label,
        detail: selectedOption.stateNote || selectedOption.detail,
        busy: workspaceBusy,
        action: {
          ...actionOption,
          label:
            actionTarget === "cloud"
              ? "Cloud workspace"
              : selectedProject
                ? "Local checkout"
                : "Check out locally",
        },
        uploadAction: uploadOption,
        options: [localOption, hybridOption, queueOption, cloudOption],
      };
    },
    [
      activeWorkspaceLocation,
      accountPending,
      accountSignedOut,
      cloudLinked,
      cloudSetupAvailable,
      cloudStateNote,
      hybridLinked,
      localStateNote,
      pendingWorkspaceTarget,
      selectedProject,
      selectedSession,
      uploadStateNote,
      workspaceBusy,
    ],
  );

  return {
    projectTarget,
    workspaceTarget,
  };
}
