import type { RightChatPanel, RightPanelMode } from "../app/app-state";

export type RightSidebarConversationState = {
  diffPanelOpen: boolean;
  diffPanelExpanded: boolean;
  rightPanelMode: RightPanelMode;
  rightChatPanels: RightChatPanel[];
};

export function defaultRightSidebarConversationState(): RightSidebarConversationState {
  return {
    diffPanelOpen: false,
    diffPanelExpanded: false,
    rightPanelMode: "changes",
    rightChatPanels: [],
  };
}

export function defaultRightSidebarConversationStateForSwitch(input: {
  keepOpen: boolean;
}): RightSidebarConversationState {
  return input.keepOpen
    ? defaultOpenRightSidebarConversationState()
    : defaultRightSidebarConversationState();
}

export function defaultOpenRightSidebarConversationState(): RightSidebarConversationState {
  return {
    diffPanelOpen: true,
    diffPanelExpanded: false,
    rightPanelMode: "home",
    rightChatPanels: [],
  };
}

export function rightSidebarConversationState(input: RightSidebarConversationState): RightSidebarConversationState {
  return {
    diffPanelOpen: input.diffPanelOpen,
    diffPanelExpanded: input.diffPanelExpanded,
    rightPanelMode: input.rightPanelMode,
    rightChatPanels: input.rightChatPanels,
  };
}

export function cloneRightSidebarConversationState(
  state: RightSidebarConversationState,
): RightSidebarConversationState {
  return {
    ...state,
    rightChatPanels: state.rightChatPanels.map((panel) => ({ ...panel })),
  };
}

export function rightSidebarConversationStatesEqual(
  left: RightSidebarConversationState,
  right: RightSidebarConversationState,
): boolean {
  if (
    left.diffPanelOpen !== right.diffPanelOpen ||
    left.diffPanelExpanded !== right.diffPanelExpanded ||
    left.rightPanelMode !== right.rightPanelMode ||
    left.rightChatPanels.length !== right.rightChatPanels.length
  ) {
    return false;
  }

  return left.rightChatPanels.every((panel, index) => {
    const other = right.rightChatPanels[index];
    return Boolean(
      other &&
        panel.id === other.id &&
        panel.sessionId === other.sessionId &&
        panel.prompt === other.prompt &&
        panel.provider === other.provider &&
        panel.model === other.model,
    );
  });
}

export function rightSidebarWorkspacePanelStateKey(input: {
  conversationId: string;
  workspaceSourceKey: string;
}): string {
  return `${input.conversationId}\u0000${input.workspaceSourceKey || "none"}`;
}
