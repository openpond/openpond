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
    initialized: messages.length > 0,
  });
  const sameScope = snapshotRef.current.scopeKey === scopeKey;
  const newIds =
    sameScope && snapshotRef.current.initialized
      ? unseenMessageIds(messages, snapshotRef.current.ids)
      : new Set<string>();

  useLayoutEffect(() => {
    snapshotRef.current = {
      scopeKey,
      ids: new Set(messages.map((message) => message.id)),
      initialized:
        sameScope && snapshotRef.current.initialized
          ? true
          : messages.length > 0,
    };
  }, [messages, sameScope, scopeKey]);

  return newIds;
}
