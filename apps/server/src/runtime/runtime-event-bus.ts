import type { ServerResponse } from "node:http";
import type { RuntimeEvent } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { sanitizeRuntimeEvent } from "./runtime-event-sanitizer.js";

type RuntimeEventLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
};

type PendingAssistantDelta = {
  event: RuntimeEvent;
  timer: ReturnType<typeof setTimeout> | null;
};

type RuntimeEventSubscriber = {
  response: ServerResponse;
  sessionId: string | null;
  ready: boolean;
  pending: RuntimeEvent[];
};

const DEFAULT_ASSISTANT_DELTA_FLUSH_MS = 40;
const MAX_ASSISTANT_DELTA_BUFFER_CHARS = 4096;
const MAX_PENDING_SUBSCRIBER_EVENTS = 1_000;
const EVENT_CATCHUP_PAGE_SIZE = 500;

export function truncateLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 20000 ? `${value.slice(0, 20000)}\n[log value truncated]` : value;
  }
  if (Array.isArray(value)) {
    if (depth > 4) return `[array:${value.length}]`;
    return value.slice(0, 50).map((item) => truncateLogValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 4) return "[object]";
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 80)
      .map(([key, child]) => [key, truncateLogValue(child, depth + 1)])
  );
}

export function createRuntimeEventBus({
  logger,
  store,
  assistantDeltaFlushMs = DEFAULT_ASSISTANT_DELTA_FLUSH_MS,
}: {
  logger: RuntimeEventLogger;
  store: SqliteStore;
  assistantDeltaFlushMs?: number;
}) {
  const subscribers = new Set<RuntimeEventSubscriber>();
  const pendingAssistantDeltas = new Map<string, PendingAssistantDelta>();

  function logRuntimeEvent(runtimeEvent: RuntimeEvent): void {
    if (
      runtimeEvent.name !== "workspace_action" &&
      runtimeEvent.name !== "workspace_action_result" &&
      runtimeEvent.name !== "tool.started" &&
      runtimeEvent.name !== "tool.completed" &&
      runtimeEvent.name !== "command.output"
    ) {
      return;
    }
    const level = runtimeEvent.status === "failed" ? "warn" : "info";
    logger[level](
      runtimeEvent.name === "workspace_action"
        ? "workspace action started"
        : runtimeEvent.name === "workspace_action_result"
          ? "workspace action completed"
          : "provider tool event",
      {
        eventId: runtimeEvent.id,
        sessionId: runtimeEvent.sessionId,
        turnId: runtimeEvent.turnId,
        source: runtimeEvent.source,
        eventName: runtimeEvent.name,
        action: runtimeEvent.action,
        appId: runtimeEvent.appId,
        status: runtimeEvent.status,
        output: runtimeEvent.output,
        error: runtimeEvent.error,
        args: truncateLogValue(runtimeEvent.args),
        data: truncateLogValue(runtimeEvent.data),
      }
    );
  }

  async function persistAndBroadcastRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void> {
    const persistedRuntimeEvent = (await store.appendRuntimeEvent(runtimeEvent)) ?? runtimeEvent;
    logRuntimeEvent(persistedRuntimeEvent);
    for (const subscriber of Array.from(subscribers)) {
      if (subscriber.response.destroyed) {
        subscribers.delete(subscriber);
        continue;
      }
      if (subscriber.sessionId && persistedRuntimeEvent.sessionId !== subscriber.sessionId) continue;
      if (!subscriber.ready) {
        subscriber.pending.push(persistedRuntimeEvent);
        if (subscriber.pending.length > MAX_PENDING_SUBSCRIBER_EVENTS) {
          disconnectSubscriber(subscriber);
        }
        continue;
      }
      writeSubscriberEvent(subscriber, persistedRuntimeEvent);
    }
  }

  async function openEventSubscriber(input: {
    response: ServerResponse;
    afterSequence: number;
    sessionId: string | null;
  }): Promise<() => void> {
    const subscriber: RuntimeEventSubscriber = {
      response: input.response,
      sessionId: input.sessionId,
      ready: false,
      pending: [],
    };
    subscribers.add(subscriber);
    let cursor = Math.max(0, Math.trunc(input.afterSequence));
    try {
      while (!input.response.destroyed) {
        const page = await store.runtimeEventPageRows({
          sessionId: input.sessionId,
          afterSequence: cursor,
          beforeSequence: null,
          limit: EVENT_CATCHUP_PAGE_SIZE,
        });
        for (const entry of page.entries) {
          if (!writeSubscriberEvent(subscriber, entry.event)) break;
          cursor = Math.max(cursor, entry.sequence);
        }
        if (page.entries.length < EVENT_CATCHUP_PAGE_SIZE) break;
      }
      const pending = subscriber.pending
        .filter((event) => (event.sequence ?? 0) > cursor)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
      subscriber.pending = [];
      subscriber.ready = true;
      for (const event of pending) {
        if (!writeSubscriberEvent(subscriber, event)) break;
      }
      return () => disconnectSubscriber(subscriber, false);
    } catch (error) {
      disconnectSubscriber(subscriber);
      throw error;
    }
  }

  function addLiveSubscriber(response: ServerResponse, sessionId: string | null = null): () => void {
    const subscriber: RuntimeEventSubscriber = { response, sessionId, ready: true, pending: [] };
    subscribers.add(subscriber);
    return () => disconnectSubscriber(subscriber, false);
  }

  async function appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void> {
    const safeRuntimeEvent = sanitizeRuntimeEvent(runtimeEvent);
    if (isCoalescibleAssistantDelta(safeRuntimeEvent)) {
      queueAssistantDelta(safeRuntimeEvent);
      return;
    }
    await flushAssistantDeltas();
    await persistAndBroadcastRuntimeEvent(safeRuntimeEvent);
  }

  async function closeEventSubscribers(): Promise<void> {
    await flushAssistantDeltas();
    for (const subscriber of Array.from(subscribers)) {
      subscribers.delete(subscriber);
      try {
        subscriber.response.end();
      } catch {
        subscriber.response.destroy();
      }
    }
  }

  function queueAssistantDelta(runtimeEvent: RuntimeEvent): void {
    const key = assistantDeltaKey(runtimeEvent);
    const existing = pendingAssistantDeltas.get(key);
    if (existing) {
      existing.event = {
        ...existing.event,
        output: `${existing.event.output ?? ""}${runtimeEvent.output ?? ""}`,
        timestamp: runtimeEvent.timestamp,
      };
      resetAssistantDeltaTimer(key, existing);
      if ((existing.event.output ?? "").length >= MAX_ASSISTANT_DELTA_BUFFER_CHARS) {
        void flushAssistantDelta(key).catch((error) => {
          logger.warn("assistant delta flush failed", { error });
        });
      }
      return;
    }
    const pending: PendingAssistantDelta = {
      event: runtimeEvent,
      timer: null,
    };
    pendingAssistantDeltas.set(key, pending);
    resetAssistantDeltaTimer(key, pending);
  }

  function resetAssistantDeltaTimer(key: string, pending: PendingAssistantDelta): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      void flushAssistantDelta(key).catch((error) => {
        logger.warn("assistant delta flush failed", { error });
      });
    }, Math.max(0, assistantDeltaFlushMs));
  }

  async function flushAssistantDeltas(): Promise<void> {
    const keys = Array.from(pendingAssistantDeltas.keys());
    for (const key of keys) await flushAssistantDelta(key);
  }

  async function flushAssistantDelta(key: string): Promise<void> {
    const pending = pendingAssistantDeltas.get(key);
    if (!pending) return;
    pendingAssistantDeltas.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    await persistAndBroadcastRuntimeEvent(pending.event);
  }

  return {
    appendRuntimeEvent,
    addLiveSubscriber,
    closeEventSubscribers,
    openEventSubscriber,
    subscribers,
    truncateLogValue,
  };

  function writeSubscriberEvent(subscriber: RuntimeEventSubscriber, event: RuntimeEvent): boolean {
    if (subscriber.response.destroyed) {
      subscribers.delete(subscriber);
      return false;
    }
    const encoded = `id: ${event.sequence ?? ""}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`;
    try {
      if (!subscriber.response.write(encoded)) {
        disconnectSubscriber(subscriber);
        return false;
      }
      return true;
    } catch {
      disconnectSubscriber(subscriber);
      return false;
    }
  }

  function disconnectSubscriber(subscriber: RuntimeEventSubscriber, destroy = true): void {
    subscribers.delete(subscriber);
    subscriber.pending = [];
    if (destroy && !subscriber.response.destroyed) subscriber.response.destroy();
  }
}

function isCoalescibleAssistantDelta(runtimeEvent: RuntimeEvent): boolean {
  return (
    runtimeEvent.name === "assistant.delta" &&
    Boolean(runtimeEvent.output) &&
    !runtimeEvent.action &&
    !runtimeEvent.args &&
    !runtimeEvent.status &&
    !runtimeEvent.error &&
    !runtimeEvent.relatedDeploymentId &&
    runtimeEvent.data === undefined
  );
}

function assistantDeltaKey(runtimeEvent: RuntimeEvent): string {
  return [
    runtimeEvent.sessionId ?? "",
    runtimeEvent.turnId ?? "",
    runtimeEvent.source ?? "",
    runtimeEvent.appId ?? "",
  ].join("\u0000");
}
