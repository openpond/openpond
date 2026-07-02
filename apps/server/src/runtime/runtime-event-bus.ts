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

const DEFAULT_ASSISTANT_DELTA_FLUSH_MS = 40;
const MAX_ASSISTANT_DELTA_BUFFER_CHARS = 4096;

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
  const subscribers = new Set<ServerResponse>();
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
    await store.appendRuntimeEvent(runtimeEvent);
    logRuntimeEvent(runtimeEvent);
    const encoded = `event: runtime\ndata: ${JSON.stringify(runtimeEvent)}\n\n`;
    for (const subscriber of Array.from(subscribers)) {
      if (subscriber.destroyed) {
        subscribers.delete(subscriber);
        continue;
      }
      try {
        subscriber.write(encoded);
      } catch {
        subscribers.delete(subscriber);
      }
    }
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
        subscriber.end();
      } catch {
        subscriber.destroy();
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
    closeEventSubscribers,
    subscribers,
    truncateLogValue,
  };
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
