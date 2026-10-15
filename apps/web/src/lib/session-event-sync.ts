import type { RuntimeEventPagePayload } from "../api";
import type { RuntimeEventStore } from "./runtime-event-store";

type PageRequest = { sessionId: string; beforeSequence?: number; afterSequence?: number; limit: number };

/** Reconcile the visible chat independently of the global bootstrap/stream cursor. */
export function createSessionEventSync(input: {
  sessionId: string;
  store: RuntimeEventStore;
  fetchPage(request: PageRequest): Promise<RuntimeEventPagePayload>;
  onPage(page: RuntimeEventPagePayload, initial: boolean): void;
  onError(error: unknown): void;
}) {
  let cursor: number | null = null;
  let closed = false;
  let active: Promise<void> | null = null;
  let refreshAgain = false;

  async function reconcile() {
    try {
      do {
        refreshAgain = false;
        let hasMore: boolean;
        do {
          const initial = cursor === null;
          const previousCursor = cursor;
          let page = await input.fetchPage({
            sessionId: input.sessionId,
            limit: 500,
            ...(initial ? { beforeSequence: Number.MAX_SAFE_INTEGER } : { afterSequence: cursor! }),
          });
          if (closed) return;
          if (initial) page = await completeInitialTurn(page);
          if (closed) return;
          // Use our last reconciled cursor, not the newest live event: a live
          // event can arrive beyond a gap while this request is in flight.
          if (!initial && page.hasMore && page.nextSequence <= previousCursor!) {
            throw new Error("Chat history did not advance. Reopen the task to retry.");
          }
          const knownIds = new Set(input.store.getSessionEvents(input.sessionId).map((event) => event.id));
          if (page.events.some((entry) => !knownIds.has(entry.event.id))) {
            input.store.mergeBootstrap(page.events.map((entry) => entry.event));
          }
          cursor = page.events.at(-1)?.sequence ?? previousCursor ?? 0;
          input.onPage(page, initial);
          hasMore = !initial && page.hasMore;
        } while (hasMore && !closed);
      } while (refreshAgain && !closed);
    } catch (error) {
      if (!closed) input.onError(error);
    }
  }

  // A tail page can start in the middle of a delta stream, even inside a
  // Markdown delimiter. Recover that one turn before publishing its text.
  async function completeInitialTurn(page: RuntimeEventPagePayload): Promise<RuntimeEventPagePayload> {
    const turnId = page.events.find(({ event }) => event.turnId)?.event.turnId;
    if (!turnId || page.events.some(({ event }) => event.turnId === turnId && event.name === "turn.started")) return page;
    let entries = page.events;
    let oldestPage = page;
    while (oldestPage.hasMore && !closed) {
      const remaining = input.store.perSessionLimit - entries.length;
      if (remaining <= 0) throw new Error("This turn exceeds the automatic history window. Load older messages to recover its beginning.");
      const older = await input.fetchPage({
        sessionId: input.sessionId,
        beforeSequence: oldestPage.previousSequence,
        limit: Math.min(500, remaining),
      });
      if (closed) return page;
      if (!older.events.length || older.previousSequence >= oldestPage.previousSequence) {
        throw new Error("Chat history did not advance. Reopen the task to retry.");
      }
      const start = older.events.findIndex(({ event }) => event.turnId === turnId && event.name === "turn.started");
      const retained = start >= 0 ? older.events.slice(start) : older.events;
      entries = [...retained, ...entries];
      oldestPage = older;
      if (start >= 0) {
        return { ...page, events: entries, previousSequence: entries[0]!.sequence,
          hasMore: older.hasMore || start > 0, remainingMatchingEvents: older.remainingMatchingEvents + start };
      }
    }
    return { ...page, events: entries, previousSequence: entries[0]?.sequence ?? page.previousSequence,
      hasMore: oldestPage.hasMore, remainingMatchingEvents: oldestPage.remainingMatchingEvents };
  }

  return {
    refresh(): Promise<void> {
      if (closed) return Promise.resolve();
      if (active) { refreshAgain = true; return active; }
      active = reconcile().finally(() => { active = null; });
      return active;
    },
    close() { closed = true; },
  };
}
