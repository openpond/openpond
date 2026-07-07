import { useEffect } from "react";

export type BrowserRevealDecision = {
  reveal: boolean;
  sessionIdToOpen: string | null;
};

export function browserRevealDecision(input: {
  currentConversationId: string;
  requestConversationId: string;
  sessionIds: Iterable<string>;
}): BrowserRevealDecision {
  const requestConversationId = input.requestConversationId.trim();
  if (!requestConversationId) return { reveal: false, sessionIdToOpen: null };
  if (requestConversationId === input.currentConversationId) {
    return { reveal: true, sessionIdToOpen: null };
  }
  const sessionIds = new Set(input.sessionIds);
  if (sessionIds.has(requestConversationId)) {
    return { reveal: true, sessionIdToOpen: requestConversationId };
  }
  return { reveal: false, sessionIdToOpen: null };
}

export function useBrowserRevealRequests({
  browserConversationId,
  sessionIds,
  onOpenSession,
  onShowBrowserPanel,
}: {
  browserConversationId: string;
  sessionIds: Iterable<string>;
  onOpenSession: (sessionId: string) => void;
  onShowBrowserPanel: () => void;
}) {
  useEffect(() => {
    const unsubscribe = window.openpond?.browser?.onRevealRequest?.((request) => {
      const decision = browserRevealDecision({
        currentConversationId: browserConversationId,
        requestConversationId: request.conversationId,
        sessionIds,
      });
      if (!decision.reveal) return;
      if (decision.sessionIdToOpen) {
        onOpenSession(decision.sessionIdToOpen);
      }
      onShowBrowserPanel();
    });
    return unsubscribe;
  }, [browserConversationId, onOpenSession, onShowBrowserPanel, sessionIds]);
}
