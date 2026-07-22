import { lazy, Suspense } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  Session,
  WorkspaceDiffSummary,
  WorkspaceState,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { AppAction, NewProjectMode } from "../../app/app-state";
import { projectSelectionKey, type SidebarProjectItem } from "../../lib/app-models";
import type { CommitNextStep } from "../workspace/WorkspaceGitDialogs";

const CommandMenu = lazy(() => import("../command/CommandMenu").then((module) => ({ default: module.CommandMenu })));
const SettingsView = lazy(() => import("../settings/SettingsView").then((module) => ({ default: module.SettingsView })));
const NewProjectDialog = lazy(() =>
  import("../workspace/NewProjectDialog").then((module) => ({ default: module.NewProjectDialog }))
);
const CommitDialog = lazy(() =>
  import("../workspace/WorkspaceGitDialogs").then((module) => ({ default: module.CommitDialog }))
);
const BranchDialog = lazy(() =>
  import("../workspace/WorkspaceGitDialogs").then((module) => ({ default: module.BranchDialog }))
);

export function AppSettingsRoute({
  payload,
  connection,
  diagnostics,
  initialSection,
  onPayload,
  onError,
  onToast,
  onBack,
  onOpenSourceSession,
  onOpenSkill,
  onOpenExtension,
  teamChatCurrentUserId,
  teamChatEnabled,
  teamChatNotificationMode,
  teamChatThreads,
  onTeamChatNotificationModeChange,
  onTeamChatThreadMuteChange,
}: Parameters<typeof SettingsView>[0]) {
  return (
    <Suspense fallback={null}>
      <SettingsView
        payload={payload}
        connection={connection}
        diagnostics={diagnostics}
        initialSection={initialSection}
        onPayload={onPayload}
        onError={onError}
        onToast={onToast}
        onBack={onBack}
        onOpenSourceSession={onOpenSourceSession}
        onOpenSkill={onOpenSkill}
        onOpenExtension={onOpenExtension}
        teamChatCurrentUserId={teamChatCurrentUserId}
        teamChatEnabled={teamChatEnabled}
        teamChatNotificationMode={teamChatNotificationMode}
        teamChatThreads={teamChatThreads}
        onTeamChatNotificationModeChange={onTeamChatNotificationModeChange}
        onTeamChatThreadMuteChange={onTeamChatThreadMuteChange}
      />
    </Suspense>
  );
}

export function AppLazyPanels({
  activeSessions,
  branchDialogName,
  branchDialogOpen,
  commitDialogOpen,
  commitDraft,
  commitIncludeUnstaged,
  commitMessage,
  commitNextStep,
  canPublishOpenPondProject,
  expandProject,
  newProjectBusy,
  newProjectDialogOpen,
  newProjectDirectory,
  newProjectMode,
  newProjectName,
  newProjectPath,
  projectRows,
  query,
  searchOpen,
  visibleWorkspaceDiff,
  visibleWorkspaceState,
  workspaceBusy,
  appDispatch,
  beginNewChat,
  openDefaultsSettingsFromBranchDialog,
  setBranchDialogName,
  setBranchDialogOpen,
  setCommitDialogOpen,
  setCommitDraft,
  setCommitIncludeUnstaged,
  setCommitMessage,
  setCommitNextStep,
  setNewProjectDialogOpen,
  setNewProjectName,
  setNewProjectPath,
  setQuery,
  setSearchOpen,
  submitCommitDialog,
  submitCreateWorkspaceBranch,
  submitNewProjectDialog,
}: {
  activeSessions: Session[];
  branchDialogName: string;
  branchDialogOpen: boolean;
  commitDialogOpen: boolean;
  commitDraft: boolean;
  commitIncludeUnstaged: boolean;
  commitMessage: string;
  commitNextStep: CommitNextStep;
  canPublishOpenPondProject: boolean;
  connection: ClientConnection | null;
  expandProject: (projectId: string) => void;
  newProjectBusy: boolean;
  newProjectDialogOpen: boolean;
  newProjectDirectory: string;
  newProjectMode: NewProjectMode;
  newProjectName: string;
  newProjectPath: string;
  projectRows: SidebarProjectItem[];
  query: string;
  searchOpen: boolean;
  visibleWorkspaceDiff: WorkspaceDiffSummary | null;
  visibleWorkspaceState: WorkspaceState | null;
  workspaceBusy: boolean;
  appDispatch: Dispatch<AppAction>;
  beginNewChat: () => void;
  openDefaultsSettingsFromBranchDialog: () => void;
  setBranchDialogName: Dispatch<SetStateAction<string>>;
  setBranchDialogOpen: Dispatch<SetStateAction<boolean>>;
  setCommitDialogOpen: Dispatch<SetStateAction<boolean>>;
  setCommitDraft: Dispatch<SetStateAction<boolean>>;
  setCommitIncludeUnstaged: Dispatch<SetStateAction<boolean>>;
  setCommitMessage: Dispatch<SetStateAction<string>>;
  setCommitNextStep: Dispatch<SetStateAction<CommitNextStep>>;
  setNewProjectDialogOpen: Dispatch<SetStateAction<boolean>>;
  setNewProjectName: Dispatch<SetStateAction<string>>;
  setNewProjectPath: Dispatch<SetStateAction<string>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  submitCommitDialog: () => void | Promise<void>;
  submitCreateWorkspaceBranch: () => void | Promise<void>;
  submitNewProjectDialog: () => void | Promise<void>;
}) {
  return (
    <>
      {searchOpen && (
        <Suspense fallback={null}>
          <CommandMenu
            open={searchOpen}
            query={query}
            projects={projectRows}
            sessions={activeSessions}
            onQueryChange={setQuery}
            onClose={() => {
              setSearchOpen(false);
              setQuery("");
            }}
            onNewChat={() => {
              setSearchOpen(false);
              setQuery("");
              beginNewChat();
            }}
            onOpenProject={(item) => {
              appDispatch({ type: "selectProject", projectId: item.id });
              appDispatch({ type: "patch", patch: { searchOpen: false, query: "" } });
              expandProject(item.id);
            }}
            onOpenSession={(session) => {
              appDispatch({
                type: "selectSession",
                sessionId: session.id,
                appId: session.appId,
                projectId:
                  session.workspaceKind === "local_project" && session.workspaceId
                    ? projectSelectionKey("local", session.workspaceId)
                    : null,
              });
              appDispatch({ type: "patch", patch: { searchOpen: false, query: "" } });
            }}
          />
        </Suspense>
      )}
      {newProjectDialogOpen && (
        <Suspense fallback={null}>
          <NewProjectDialog
            open={newProjectDialogOpen}
            mode={newProjectMode}
            name={newProjectName}
            path={newProjectPath}
            directory={newProjectDirectory}
            busy={newProjectBusy}
            onNameChange={setNewProjectName}
            onPathChange={setNewProjectPath}
            onClose={() => {
              if (!newProjectBusy) setNewProjectDialogOpen(false);
            }}
            onSubmit={submitNewProjectDialog}
          />
        </Suspense>
      )}
      {commitDialogOpen && (
        <Suspense fallback={null}>
          <CommitDialog
            open={commitDialogOpen}
            branch={visibleWorkspaceState?.currentBranch ?? null}
            filesChanged={visibleWorkspaceDiff?.filesChanged ?? visibleWorkspaceState?.changedFilesCount ?? 0}
            additions={visibleWorkspaceDiff?.additions ?? 0}
            deletions={visibleWorkspaceDiff?.deletions ?? 0}
            message={commitMessage}
            includeUnstaged={commitIncludeUnstaged}
            nextStep={commitNextStep}
            draft={commitDraft}
            busy={workspaceBusy}
            canPush={Boolean(visibleWorkspaceState?.remoteUrl)}
            canPublish={canPublishOpenPondProject}
            onMessageChange={setCommitMessage}
            onIncludeUnstagedChange={setCommitIncludeUnstaged}
            onNextStepChange={setCommitNextStep}
            onDraftChange={setCommitDraft}
            onClose={() => {
              if (!workspaceBusy) setCommitDialogOpen(false);
            }}
            onSubmit={submitCommitDialog}
          />
        </Suspense>
      )}
      {branchDialogOpen && (
        <Suspense fallback={null}>
          <BranchDialog
            open={branchDialogOpen}
            branchName={branchDialogName}
            busy={workspaceBusy}
            onBranchNameChange={setBranchDialogName}
            onSetPrefix={openDefaultsSettingsFromBranchDialog}
            onClose={() => {
              if (!workspaceBusy) setBranchDialogOpen(false);
            }}
            onSubmit={submitCreateWorkspaceBranch}
          />
        </Suspense>
      )}
    </>
  );
}
