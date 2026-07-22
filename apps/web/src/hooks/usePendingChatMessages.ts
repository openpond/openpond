import { useCallback, useEffect, useMemo, useState } from "react";
import { appendPendingUserChatMessage, hasMatchingUserMessage, type PendingChatUserMessage } from "../lib/pending-chat-messages";
import { buildCachedChatMessages } from "../lib/chat-messages";
import { buildRuntimeIndexes, runtimeEventsForSession } from "../lib/runtime-indexes";

export function usePendingChatMessages(input: {
  chatMessages: ReturnType<typeof buildCachedChatMessages>;
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
  selectedSessionId: string | null;
}) {
  const { chatMessages, runtimeIndexes, selectedSessionId } = input;
  const [pendingChatUserMessages, setPendingChatUserMessages] = useState<
    Record<string, PendingChatUserMessage>
  >({});

  const recordPendingChatUserMessage = useCallback((message: PendingChatUserMessage) => {
    setPendingChatUserMessages((current) => ({
      ...current,
      [message.sessionId]: message,
    }));
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
    pendingChatUserMessages,
    recordPendingChatUserMessage,
    visibleChatMessages,
  };
}
