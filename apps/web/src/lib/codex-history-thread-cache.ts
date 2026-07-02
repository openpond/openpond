import type { RuntimeEvent, Session } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

export type CodexHistoryThreadPayload = {
  session: Session;
  events: RuntimeEvent[];
};

export const CODEX_HISTORY_THREAD_TAIL_LIMIT = 800;
export const CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT = 5_000;
export const CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT = 50_000;

const CODEX_HISTORY_CACHE_LIMIT = 16;
const CODEX_HISTORY_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  fetchedAt: number;
  payload?: CodexHistoryThreadPayload;
  promise?: Promise<CodexHistoryThreadPayload>;
};

const threadPayloadCache = new Map<string, CacheEntry>();

export function cachedCodexHistoryThreadPayload(
  connection: ClientConnection,
  sessionId: string,
): CodexHistoryThreadPayload | null {
  return threadPayloadCache.get(cacheKey(connection, sessionId))?.payload ?? null;
}

export function prefetchCodexHistoryThreadPayload(connection: ClientConnection, sessionId: string): void {
  void loadCodexHistoryThreadPayload(connection, sessionId).catch(() => undefined);
}

export async function loadCodexHistoryThreadPayload(
  connection: ClientConnection,
  sessionId: string,
  options: { force?: boolean; limit?: number; tail?: boolean } = {},
): Promise<CodexHistoryThreadPayload> {
  const key = cacheKey(connection, sessionId);
  const existing = threadPayloadCache.get(key);
  if (existing?.promise) return existing.promise;
  if (
    !options.force &&
    existing?.payload &&
    Date.now() - existing.fetchedAt <= CODEX_HISTORY_CACHE_TTL_MS
  ) {
    touchCacheEntry(key, existing);
    return existing.payload;
  }

  const limit = options.limit ?? CODEX_HISTORY_THREAD_TAIL_LIMIT;
  const tail = options.tail ?? true;
  const promise = api
    .codexHistoryThread(connection, sessionId, {
      limit,
      tail,
    })
    .then((payload) => {
      const existingPayload = threadPayloadCache.get(key)?.payload ?? existing?.payload;
      const nextPayload = tail && existingPayload
        ? {
            ...payload,
            events: mergeCodexHistoryEvents(existingPayload.events, payload.events),
          }
        : payload;
      threadPayloadCache.set(key, {
        fetchedAt: Date.now(),
        payload: nextPayload,
      });
      trimCache();
      return nextPayload;
    })
    .catch((error) => {
      const current = threadPayloadCache.get(key);
      if (current?.promise === promise) threadPayloadCache.delete(key);
      throw error;
    });

  threadPayloadCache.set(key, {
    fetchedAt: existing?.fetchedAt ?? 0,
    payload: existing?.payload,
    promise,
  });
  trimCache();
  return promise;
}

function cacheKey(connection: ClientConnection, sessionId: string): string {
  return `${connection.serverUrl}\n${connection.token}\n${sessionId}`;
}

function touchCacheEntry(key: string, entry: CacheEntry): void {
  threadPayloadCache.delete(key);
  threadPayloadCache.set(key, entry);
}

function trimCache(): void {
  while (threadPayloadCache.size > CODEX_HISTORY_CACHE_LIMIT) {
    const oldestKey = threadPayloadCache.keys().next().value;
    if (!oldestKey) return;
    threadPayloadCache.delete(oldestKey);
  }
}

function mergeCodexHistoryEvents(existingEvents: RuntimeEvent[], incomingEvents: RuntimeEvent[]): RuntimeEvent[] {
  const eventsById = new Map<string, RuntimeEvent>();
  for (const event of existingEvents) eventsById.set(event.id, event);
  for (const event of incomingEvents) eventsById.set(event.id, event);
  return Array.from(eventsById.values());
}
