import { useLayoutEffect, useRef } from "react";

type IdentifiedMessage = { id: string; timestamp?: string | null };

export function unseenMessageIds(
  messages: IdentifiedMessage[],
  seenIds: ReadonlySet<string>,
  cutoffTimestamp?: number
): Set<string> {
  return new Set(
    messages
      .filter((message) => {
        if (seenIds.has(message.id)) return false;
        if (cutoffTimestamp === undefined) return true;
        if (typeof message.timestamp !== "string") return false;
        const timestamp = Date.parse(message.timestamp);
        return Number.isFinite(timestamp) && timestamp >= cutoffTimestamp;
      })
      .map((message) => message.id)
  );
}

function latestHistoryTimestamp(messages: IdentifiedMessage[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (typeof message.timestamp !== "string") continue;
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    latest = latest === null ? timestamp : Math.max(latest, timestamp);
  }
  return latest;
}

/**
 * Distinguishes messages received after a thread is on screen from history
 * loaded when that thread first opens.
 *
 * A message only counts as "new" once the thread has finished its initial
 * load AND its own timestamp is later than that load. History that arrives in
 * later paged batches therefore never replays the entrance animation, while
 * chunks streamed live while the thread is on screen still animate.
 */
export function useNewMessageIds(
  messages: IdentifiedMessage[],
  scopeKey: string
): ReadonlySet<string> {
  const snapshotRef = useRef({
    scopeKey,
    ids: new Set(messages.map((message) => message.id)),
    initialized: false,
    liveCutoff: null as number | null,
  });
  const sameScope = snapshotRef.current.scopeKey === scopeKey;
  const initialized = sameScope && snapshotRef.current.initialized;
  const newIds = initialized
    ? unseenMessageIds(
        messages,
        snapshotRef.current.ids,
        snapshotRef.current.liveCutoff ?? undefined
      )
    : new Set<string>();

  useLayoutEffect(() => {
    const previous = snapshotRef.current;
    const scopeChanged = previous.scopeKey !== scopeKey;
    const now = Date.now();
    snapshotRef.current = {
      scopeKey,
      ids: new Set(messages.map((message) => message.id)),
      initialized: scopeChanged ? false : true,
      liveCutoff: scopeChanged
        ? Math.max(now, latestHistoryTimestamp(messages) ?? 0)
        : previous.liveCutoff ??
          Math.max(now, latestHistoryTimestamp(messages) ?? 0),
    };
  }, [messages, sameScope, scopeKey]);

  return newIds;
}
