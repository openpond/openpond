import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { Session } from "@openpond/contracts";
import type { AppAction, RightChatPanel, RightPanelMode } from "../app/app-state";
import type { AppView } from "../lib/app-models";
import {
  cloneRightSidebarConversationState,
  defaultRightSidebarConversationStateForSwitch,
  rightSidebarConversationState,
  rightSidebarConversationStatesEqual,
  rightSidebarWorkspacePanelStateKey,
  type RightSidebarConversationState,
} from "../lib/right-sidebar-conversation-state";
import {
  cloneWorkspaceDiffPanelViewState,
  defaultWorkspaceDiffPanelViewState,
  workspaceDiffPanelViewStatesEqual,
  type WorkspaceDiffPanelViewState,
} from "../components/workspace-diff/workspace-diff-panel-model";
import { isCloudWorkspaceKind } from "../lib/workspace-location";

export function useConversationSidebarState(input: {
  appDispatch: Dispatch<AppAction>;
  diffPanelExpanded: boolean;
  diffPanelOpen: boolean;
  rightChatPanels: RightChatPanel[];
  rightPanelMode: RightPanelMode;
  selectedAppId: string | null;
  selectedCloudProject: { id: string } | null;
  selectedCloudWorkItem: { id: string } | null;
  selectedProjectId: string | null;
  selectedSession: Pick<Session, "cwd" | "workspaceKind"> | null;
  selectedSessionId: string | null;
  setWorkspaceDiffPanelViewState: Dispatch<SetStateAction<WorkspaceDiffPanelViewState>>;
  view: AppView;
  viewWorkspaceAppId: string | null;
  viewWorkspaceId: string | null;
  viewWorkspaceKind: string | null | undefined;
  workspaceDiffPanelViewState: WorkspaceDiffPanelViewState;
}) {
  const {
    appDispatch,
    diffPanelExpanded,
    diffPanelOpen,
    rightChatPanels,
    rightPanelMode,
    selectedAppId,
    selectedCloudProject,
    selectedCloudWorkItem,
    selectedProjectId,
    selectedSession,
    selectedSessionId,
    setWorkspaceDiffPanelViewState,
    view,
    viewWorkspaceAppId,
    viewWorkspaceId,
    viewWorkspaceKind,
    workspaceDiffPanelViewState,
  } = input;
  const rightSidebarStateByConversationRef = useRef<Map<string, RightSidebarConversationState>>(
    new Map(),
  );
  const workspaceDiffPanelStateByScopeRef = useRef<Map<string, WorkspaceDiffPanelViewState>>(
    new Map(),
  );
  const activeRightSidebarConversationRef = useRef<string | null>(null);
  const activeWorkspaceDiffPanelStateKeyRef = useRef<string | null>(null);

  const browserConversationId =
    selectedSessionId ??
    `draft:${selectedProjectId ?? selectedAppId ?? selectedCloudProject?.id ?? "general"}`;
  const workspaceDiffPanelSourceKey = useMemo(() => {
    if (view === "cloud" && selectedCloudWorkItem?.id)
      return `cloud-work:${selectedCloudWorkItem.id}`;
    if (viewWorkspaceId) return `${viewWorkspaceKind ?? "workspace"}:${viewWorkspaceId}`;
    if (viewWorkspaceAppId) return `app:${viewWorkspaceAppId}`;
    if (selectedSession?.cwd && !isCloudWorkspaceKind(selectedSession.workspaceKind)) {
      return `cwd:${selectedSession.cwd}`;
    }
    return "none";
  }, [
    selectedCloudWorkItem?.id,
    selectedSession?.cwd,
    selectedSession?.workspaceKind,
    view,
    viewWorkspaceAppId,
    viewWorkspaceId,
    viewWorkspaceKind,
  ]);
  const workspaceDiffPanelStateKey = rightSidebarWorkspacePanelStateKey({
    conversationId: browserConversationId,
    workspaceSourceKey: workspaceDiffPanelSourceKey,
  });
  const currentRightSidebarConversationState = useMemo(
    () =>
      rightSidebarConversationState({
        diffPanelExpanded,
        diffPanelOpen,
        rightChatPanels,
        rightPanelMode,
      }),
    [diffPanelExpanded, diffPanelOpen, rightChatPanels, rightPanelMode],
  );
  useEffect(() => {
    const activeConversationId = activeRightSidebarConversationRef.current;
    if (!activeConversationId) return;
    rightSidebarStateByConversationRef.current.set(
      activeConversationId,
      cloneRightSidebarConversationState(currentRightSidebarConversationState),
    );
  }, [browserConversationId, currentRightSidebarConversationState]);
  useEffect(() => {
    const previousConversationId = activeRightSidebarConversationRef.current;
    if (previousConversationId === browserConversationId) return;

    activeRightSidebarConversationRef.current = browserConversationId;
    const restoredState =
      rightSidebarStateByConversationRef.current.get(browserConversationId) ??
      defaultRightSidebarConversationStateForSwitch({
        keepOpen: currentRightSidebarConversationState.diffPanelOpen,
      });
    if (rightSidebarConversationStatesEqual(currentRightSidebarConversationState, restoredState))
      return;
    appDispatch({
      type: "patch",
      patch: cloneRightSidebarConversationState(restoredState),
    });
  }, [browserConversationId, currentRightSidebarConversationState]);
  useEffect(() => {
    const activeStateKey = activeWorkspaceDiffPanelStateKeyRef.current;
    if (!activeStateKey) return;
    workspaceDiffPanelStateByScopeRef.current.set(
      activeStateKey,
      cloneWorkspaceDiffPanelViewState(workspaceDiffPanelViewState),
    );
  }, [workspaceDiffPanelStateKey, workspaceDiffPanelViewState]);
  useEffect(() => {
    const previousStateKey = activeWorkspaceDiffPanelStateKeyRef.current;
    if (previousStateKey === workspaceDiffPanelStateKey) return;

    activeWorkspaceDiffPanelStateKeyRef.current = workspaceDiffPanelStateKey;
    const restoredWorkspaceDiffPanelState =
      workspaceDiffPanelStateByScopeRef.current.get(workspaceDiffPanelStateKey) ??
      defaultWorkspaceDiffPanelViewState();
    setWorkspaceDiffPanelViewState((current) =>
      workspaceDiffPanelViewStatesEqual(current, restoredWorkspaceDiffPanelState)
        ? current
        : cloneWorkspaceDiffPanelViewState(restoredWorkspaceDiffPanelState),
    );
  }, [workspaceDiffPanelStateKey]);
  const handleWorkspaceDiffPanelViewStateChange = useCallback(
    (state: WorkspaceDiffPanelViewState) => {
      setWorkspaceDiffPanelViewState((current) =>
        workspaceDiffPanelViewStatesEqual(current, state)
          ? current
          : cloneWorkspaceDiffPanelViewState(state),
      );
    },
    [],
  );

  return {
    browserConversationId,
    handleWorkspaceDiffPanelViewStateChange,
  };
}
