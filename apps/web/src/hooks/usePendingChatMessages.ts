import { useCallback, useEffect, useMemo, useState } from "react";
import { appendPendingUserChatMessage, hasMatchingUserMessage, type PendingChatUserMessage } from "../lib/pending-chat-messages";
import { buildCachedChatMessages } from "../lib/chat-messages";
import { buildRuntimeIndexes, runtimeEventsForSession } from "../lib/runtime-indexes";

export function usePendingChatMessages(input: {
  chatMessages: ReturnType<typeof buildCachedChatMessages>;
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
  selectedSessionId: string | null;
  serverId: string | null | undefined;
}) {
  const { chatMessages, runtimeIndexes, selectedSessionId, serverId } = input;
  const [pendingChatUserMessages, setPendingChatUserMessages] = useState<
    Record<string, PendingChatUserMessage>
  >({});

  useEffect(() => {
    setPendingChatUserMessages({});
  }, [serverId]);

  const recordPendingChatUserMessage = useCallback((message: PendingChatUserMessage) => {
    setPendingChatUserMessages((current) => ({
      ...current,
      [message.sessionId]: message,
    }));
  }, []);
  const clearPendingChatUserMessage = useCallback((sessionId: string, messageId: string) => {
    setPendingChatUserMessages((current) => {
      if (current[sessionId]?.id !== messageId) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);
  useEffect(() => {
    setPendingChatUserMessages((current) => {
      let next = current;
      for (const [sessionId, pendingMessage] of Object.entries(current)) {
        const realMessages = buildCachedChatMessages(
          runtimeEventsForSession(runtimeIndexes, sessionId),
        );
        if (!hasMatchingUserMessage(realMessages, pendingMessage)) continue;
        if (next === current) next = { ...current };
        delete next[sessionId];
      }
      return next;
    });
  }, [runtimeIndexes]);
  const visibleChatMessages = useMemo(
    () =>
      appendPendingUserChatMessage(
        chatMessages,
        selectedSessionId ? pendingChatUserMessages[selectedSessionId] : null,
      ),
    [chatMessages, pendingChatUserMessages, selectedSessionId],
  );

  return {
    clearPendingChatUserMessage,
    pendingChatUserMessages,
    recordPendingChatUserMessage,
    visibleChatMessages,
  };
}
