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
          const page = await input.fetchPage({
            sessionId: input.sessionId,
            limit: 500,
            ...(initial ? { beforeSequence: Number.MAX_SAFE_INTEGER } : { afterSequence: cursor! }),
          });
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
