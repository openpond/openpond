import { useLayoutEffect, useRef } from "react";

type IdentifiedMessage = { id: string };

export function unseenMessageIds(
  messages: IdentifiedMessage[],
  seenIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    messages
      .filter((message) => !seenIds.has(message.id))
      .map((message) => message.id)
  );
}

/**
 * Distinguishes messages received after a thread is on screen from history
 * loaded when that thread first opens.
 */
export function useNewMessageIds(
  messages: IdentifiedMessage[],
  scopeKey: string
): ReadonlySet<string> {
  const snapshotRef = useRef({
    scopeKey,
    ids: new Set(messages.map((message) => message.id)),
    initialized: false,
    pendingInitial: messages.length > 0,
  });
  const sameScope = snapshotRef.current.scopeKey === scopeKey;
  const newIds =
    sameScope && snapshotRef.current.initialized
      ? unseenMessageIds(messages, snapshotRef.current.ids)
      : new Set<string>();

  useLayoutEffect(() => {
    const wasPendingInitial = snapshotRef.current.pendingInitial;
    const hadMessages = messages.length > 0;
    snapshotRef.current = {
      scopeKey,
      ids: new Set(messages.map((message) => message.id)),
      initialized:
        sameScope && snapshotRef.current.initialized
          ? true
          : wasPendingInitial && hadMessages,
      pendingInitial:
        sameScope && snapshotRef.current.initialized
          ? false
          : !wasPendingInitial && hadMessages,
    };
  }, [messages, sameScope, scopeKey]);

  return newIds;
}
