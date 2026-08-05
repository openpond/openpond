import { useMemo } from "react";
import { localPathWorkspaceId } from "@openpond/contracts";
import type {
  AccountState,
  BootstrapPayload,
  ChatProvider,
  CloudProject,
  LocalProject,
  OpenPondApp,
  Session,
  WorkspaceState,
  WorkspaceKind,
} from "@openpond/contracts";
import type {
  ComposerProjectTargetOption,
  ComposerProjectTargetState,
} from "../components/chat/Composer";
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

function firstPresentText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function activeChatProviderForWorkspace({
  draftProvider,
  hasSelectedCloudProject,
  selectedSessionHybridWorkspace,
}: {
  draftProvider: ChatProvider;
  hasSelectedCloudProject: boolean;
  selectedSessionHybridWorkspace: boolean;
}): ChatProvider {
  return hasSelectedCloudProject && !selectedSessionHybridWorkspace
    ? "openpond"
    : draftProvider;
}

export const COMPOSER_PROJECT_ACTION_OPTIONS = [
  {
    value: "action:new-local-project",
    label: "New local project",
    detail: "Create a new project folder on this machine",
    kind: "action",
  },
  {
    value: "action:add-local-project",
    label: "Use existing folder",
    detail: "Choose a folder on this machine",
    kind: "action",
  },
  {
    value: "action:add-local-project-path",
    label: "Use existing folder path",
    detail: "Enter a local folder path manually",
    kind: "action",
  },
  {
    value: "action:new-cloud-project",
    label: "New cloud project",
    detail: "Create a project in OpenPond Cloud",
    kind: "action",
  },
  {
    value: "action:create-cloud-environment",
    label: "Create cloud environment",
    detail: "Set up compute for a cloud project",
    kind: "action",
  },
] satisfies readonly ComposerProjectTargetOption[];

function firstPresentNonEmailText(...values: Array<string | null | undefined>): string {
  return firstPresentText(...values.map((value) => {
    const trimmed = value?.trim();
    return trimmed && !trimmed.includes("@") ? trimmed : null;
  }));
}

export function accountWelcomeIdentity(account: AccountState | null | undefined): string {
  if (account?.state !== "signed_in") return "";
  const activeAccount = account.accounts.find((candidate) => candidate.isActive) ?? null;
  return firstPresentNonEmailText(
    account.profile?.name,
    account.label,
    activeAccount?.displayLabel,
    account.profile?.handle,
    activeAccount?.handle,
    account.activeProfile?.handle,
  );
}

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
  const selectedSessionLocalPathWorkspaceId =
    selectedSession?.cwd && (!selectedSessionCloudWorkspace || selectedSessionHybridWorkspace)
      ? localPathWorkspaceId(selectedSession.cwd)
      : null;
  const providerSettings = bootstrap?.providers ?? null;
  const selectedProjectConfirmedCloudProject = confirmedLinkedCloudProject(
    selectedProject,
    bootstrap?.cloudProjects ?? [],
  );
  const activeProvider = activeChatProviderForWorkspace({
    draftProvider,
    hasSelectedCloudProject: Boolean(selectedCloudProject),
    selectedSessionHybridWorkspace,
  });
  const activeModel =
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
            : (selectedSession.workspaceKind ??
                (selectedSession.appId
                  ? "sandbox_app"
                  : selectedSessionLocalPathWorkspaceId
                    ? "local_project"
                    : null))
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
          : (selectedSession.workspaceId ?? selectedSession.appId ?? selectedSessionLocalPathWorkspaceId)
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
              selectedSession.workspaceId ??
              selectedSession.appId ??
              selectedSessionLocalPathWorkspaceId)
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
  const welcomeIdentity = accountWelcomeIdentity(account);
  const startMessage = welcomeIdentity ? `Welcome, ${welcomeIdentity}` : "Welcome";
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
    selectedSessionLocalPathWorkspaceId,
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
  pendingWorkspaceTarget: "hybrid" | null;
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
        ...COMPOSER_PROJECT_ACTION_OPTIONS,
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
        options: [localOption, hybridOption, cloudOption],
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
