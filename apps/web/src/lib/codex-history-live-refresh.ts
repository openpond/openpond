import type { Session } from "@openpond/contracts";
import type { ClientConnection } from "../api";
import {
  cachedCodexHistoryThreadPayload,
  loadCodexHistoryThreadPayload,
  type CodexHistoryThreadPayload,
} from "./codex-history-thread-cache";
import { latestGoalRuntimeFromEvents } from "./goal-runtime";

export type CodexHistoryRefreshSurface = "sidebar" | "thread";

const ACTIVE_REFRESH_INTERVAL_MS = 500;
const IDLE_THREAD_REFRESH_INTERVAL_MS = 2_500;
const IDLE_SIDEBAR_REFRESH_INTERVAL_MS = 15_000;

export function codexHistoryRefreshDelayMs(input: {
  active: boolean;
  surface: CodexHistoryRefreshSurface;
}): number {
  if (input.active) return ACTIVE_REFRESH_INTERVAL_MS;
  return input.surface === "thread"
    ? IDLE_THREAD_REFRESH_INTERVAL_MS
    : IDLE_SIDEBAR_REFRESH_INTERVAL_MS;
}

export function codexHistoryPayloadWithLiveStatus<
  Payload extends { session: Session },
>(payload: Payload, live: boolean): Payload {
  if (!live || payload.session.status === "active") return payload;
  return {
    ...payload,
    session: { ...payload.session, status: "active" },
  };
}

type CodexHistoryLiveRefreshSubscription = {
  connection: ClientConnection;
  locallyActive: boolean;
  onError?: (error: unknown) => void;
  onPayload: (payload: CodexHistoryThreadPayload) => void;
  reportedActive: boolean;
  sessionId: string;
  surface: CodexHistoryRefreshSurface;
};

type RefreshTimer = ReturnType<typeof globalThis.setTimeout>;

type RefreshEntry = {
  connection: ClientConnection;
  disposed: boolean;
  inFlight: Promise<CodexHistoryThreadPayload> | null;
  latestPayload: CodexHistoryThreadPayload | null;
  nextRefreshAt: number | null;
  sessionId: string;
  subscribers: Map<number, CodexHistoryLiveRefreshSubscription>;
  timer: RefreshTimer | null;
};

type CodexHistoryLiveRefreshDependencies = {
  cachedPayload: typeof cachedCodexHistoryThreadPayload;
  clearTimer: (timer: RefreshTimer) => void;
  loadPayload: typeof loadCodexHistoryThreadPayload;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => RefreshTimer;
};

export function createCodexHistoryLiveRefreshCoordinator(
  dependencies: Partial<CodexHistoryLiveRefreshDependencies> = {},
) {
  const deps: CodexHistoryLiveRefreshDependencies = {
    cachedPayload: dependencies.cachedPayload ?? cachedCodexHistoryThreadPayload,
    clearTimer: dependencies.clearTimer ?? ((timer) => globalThis.clearTimeout(timer)),
    loadPayload: dependencies.loadPayload ?? loadCodexHistoryThreadPayload,
    now: dependencies.now ?? Date.now,
    setTimer:
      dependencies.setTimer ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs)),
  };
  const entries = new Map<string, RefreshEntry>();
  let nextSubscriberId = 1;

  function subscribe(input: CodexHistoryLiveRefreshSubscription): () => void {
    const key = refreshKey(input.connection, input.sessionId);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        connection: input.connection,
        disposed: false,
        inFlight: null,
        latestPayload: deps.cachedPayload(input.connection, input.sessionId),
        nextRefreshAt: null,
        sessionId: input.sessionId,
        subscribers: new Map(),
        timer: null,
      };
      entries.set(key, entry);
    }

    const subscriberId = nextSubscriberId++;
    entry.subscribers.set(subscriberId, input);
    if (entry.latestPayload) input.onPayload(entry.latestPayload);
    schedule(entry, 0);

    return () => {
      const current = entries.get(key);
      if (!current) return;
      current.subscribers.delete(subscriberId);
      if (current.subscribers.size > 0) {
        schedule(current, refreshDelayForEntry(current));
        return;
      }
      current.disposed = true;
      clearScheduledRefresh(current);
      entries.delete(key);
    };
  }

  function schedule(entry: RefreshEntry, delayMs: number): void {
    if (entry.disposed || entry.subscribers.size === 0 || entry.inFlight) return;
    const nextRefreshAt = deps.now() + Math.max(0, delayMs);
    if (entry.timer && entry.nextRefreshAt !== null && entry.nextRefreshAt <= nextRefreshAt) return;
    clearScheduledRefresh(entry);
    entry.nextRefreshAt = nextRefreshAt;
    entry.timer = deps.setTimer(() => {
      entry.timer = null;
      entry.nextRefreshAt = null;
      void refresh(entry);
    }, Math.max(0, delayMs));
  }

  async function refresh(entry: RefreshEntry): Promise<void> {
    if (entry.disposed || entry.subscribers.size === 0 || entry.inFlight) return;
    const request = deps.loadPayload(entry.connection, entry.sessionId, {
      force: Boolean(entry.latestPayload),
    });
    entry.inFlight = request;
    try {
      const payload = await request;
      if (entry.disposed) return;
      entry.latestPayload = payload;
      for (const subscriber of entry.subscribers.values()) subscriber.onPayload(payload);
    } catch (error) {
      if (entry.disposed) return;
      for (const subscriber of entry.subscribers.values()) subscriber.onError?.(error);
    } finally {
      if (entry.inFlight === request) entry.inFlight = null;
      if (!entry.disposed) schedule(entry, refreshDelayForEntry(entry));
    }
  }

  function refreshDelayForEntry(entry: RefreshEntry): number {
    const subscribers = [...entry.subscribers.values()];
    const active =
      subscribers.some((subscriber) => subscriber.locallyActive || subscriber.reportedActive) ||
      entry.latestPayload?.session.status === "active" ||
      latestGoalRuntimeFromEvents(entry.latestPayload?.events ?? [])?.tone === "active";
    const surface = subscribers.some((subscriber) => subscriber.surface === "thread")
      ? "thread"
      : "sidebar";
    return codexHistoryRefreshDelayMs({ active, surface });
  }

  function clearScheduledRefresh(entry: RefreshEntry): void {
    if (entry.timer) deps.clearTimer(entry.timer);
    entry.timer = null;
    entry.nextRefreshAt = null;
  }

  return { subscribe };
}

const codexHistoryLiveRefreshCoordinator = createCodexHistoryLiveRefreshCoordinator();

export function subscribeCodexHistoryLiveRefresh(
  input: CodexHistoryLiveRefreshSubscription,
): () => void {
  return codexHistoryLiveRefreshCoordinator.subscribe(input);
}

function refreshKey(connection: ClientConnection, sessionId: string): string {
  return `${connection.serverUrl}\n${connection.token}\n${sessionId}`;
}
