import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuntimeEvent, SendTurnRequest, TaskInput, TaskInputMutation } from "@openpond/contracts";
import { ApiRequestError } from "../api/api-client";
import { sessionApi } from "../api/session-api";
import type { ClientConnection } from "../api/api-client";
import { connectionQueryScope } from "../lib/query-scope";

const INPUT_EVENTS = new Set(["task.inbox", "task.input", "task.wait", "turn.started", "turn.completed", "turn.failed", "turn.interrupted", "approval.requested", "approval.resolved"]);
type PendingIntent = { body: string; kind: "steer" | "queued"; key: string; turnId: string | null; request?: SendTurnRequest };

function savedIntent(storageKey: string): PendingIntent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as PendingIntent | null;
    return value && typeof value.body === "string" && typeof value.key === "string" && (value.kind === "steer" || value.kind === "queued") ? value : null;
  } catch { return null; }
}

export function useTaskInbox(connection: ClientConnection | null, sessionId: string | null, events: readonly RuntimeEvent[]) {
  const queries = useQueryClient();
  const scope = connectionQueryScope(connection);
  const queryKey = useMemo(() => ["task-inbox", scope, sessionId] as const, [scope, sessionId]);
  const enabled = Boolean(connection && sessionId);
  const state = useQuery({ queryKey, enabled, staleTime: 0, refetchOnWindowFocus: true, refetchOnReconnect: true,
    queryFn: () => sessionApi.taskInbox(connection!, sessionId!),
  });
  const [operation, setOperation] = useState<{ scope: string; id: string } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const operationScope = `${scope}:${sessionId}`;
  let eventRevision: string | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.sessionId === sessionId && INPUT_EVENTS.has(event.name)) { eventRevision = event.id; break; }
  }
  const refresh = useCallback(async () => {
    if (enabled) await queries.invalidateQueries({ queryKey, exact: true });
  }, [enabled, queries, queryKey]);
  useEffect(() => { void refresh(); }, [refresh, eventRevision]);
  useEffect(() => {
    const onReconnect = () => { void refresh(); };
    window.addEventListener("openpond-runtime-connected", onReconnect);
    return () => window.removeEventListener("openpond-runtime-connected", onReconnect);
  }, [refresh]);

  async function perform(id: string, work: () => Promise<TaskInput>): Promise<boolean> {
    if (!enabled) return false;
    setOperation({ scope: operationScope, id });
    setFailure(null);
    try {
      const receipt = await work();
      await queries.cancelQueries({ queryKey, exact: true });
      queries.setQueryData(queryKey, (current: typeof state.data) => current ? {
        ...current, inputs: [...current.inputs.filter((row) => row.id !== receipt.id), receipt].sort((a, b) => a.sequence - b.sequence),
      } : current);
      // The receipt is already durable. A later refresh failure must not make a successful send look unsent.
      void refresh();
      return true;
    } catch (error) {
      setFailure({ scope: operationScope, message: error instanceof Error ? error.message : String(error) });
      void refresh();
      return false;
    } finally {
      setOperation((current) => current?.scope === operationScope && current.id === id ? null : current);
    }
  }

  async function send(kind: PendingIntent["kind"], body: string, request?: SendTurnRequest): Promise<boolean> {
    if (!connection || !sessionId) return false;
    const storageKey = `openpond:task-input:${connection.serverUrl}:${sessionId}`;
    const previous = savedIntent(storageKey);
    const retrying = previous?.body === body && previous.kind === kind;
    const intent = retrying ? previous : {
      body, kind, request, key: crypto.randomUUID(), turnId: kind === "steer" ? state.data?.activeTurnId ?? null : null,
    };
    if (kind === "steer" && (!intent.turnId || (!retrying && !state.data?.acceptingInput))) {
      setFailure({ scope: operationScope, message: "This turn is no longer accepting steering. Your text is still in the composer; send it as a follow-up or queue it." });
      void refresh(); return false;
    }
    try { sessionStorage.setItem(storageKey, JSON.stringify(intent)); } catch { /* Browser storage may be unavailable. */ }
    const sent = await perform(intent.key, async () => {
      let receipt: TaskInput;
      try { receipt = await (kind === "steer"
      ? sessionApi.steerTurn(connection, sessionId, { prompt: body, expectedTurnId: intent.turnId!, idempotencyKey: intent.key })
      : sessionApi.queueTaskInput(connection, sessionId, intent.request!, intent.key));
      } catch (error) {
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
          try { sessionStorage.removeItem(storageKey); } catch { /* Storage is optional. */ }
        }
        throw error;
      }
      if (receipt.state === "rejected" || receipt.state === "cancelled") {
        try { sessionStorage.removeItem(storageKey); } catch { /* Storage is optional. */ }
        throw new Error(receipt.error ?? "This input was cancelled. Review your text before sending again.");
      }
      return receipt;
    });
    if (sent) {
      try { if (savedIntent(storageKey)?.key === intent.key) sessionStorage.removeItem(storageKey); } catch { /* No durable browser state to clear. */ }
    }
    return sent;
  }

  return {
    enabled, snapshot: state.data ?? null,
    busyId: operation?.scope === operationScope ? operation.id : null,
    error: failure?.scope === operationScope ? failure.message : state.error?.message ?? null,
    steer: (body: string) => send("steer", body),
    queue: (request: SendTurnRequest) => send("queued", request.prompt, request),
    mutate: (input: TaskInput, mutation: TaskInputMutation) => perform(input.id, () => sessionApi.updateTaskInput(connection!, sessionId!, input.id, mutation)),
    refresh,
  };
}

export type TaskInboxController = ReturnType<typeof useTaskInbox>;
