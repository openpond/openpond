import { retainedTaskInputAcknowledgement } from "../lib/task-input-acknowledgement";
import { taskInboxWithReceipt } from "../lib/task-inbox-receipts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatAttachment, RuntimeEvent, SendTurnRequest, TaskInput, TaskInputMutation, TaskInboxSnapshot } from "@openpond/contracts";
import type { TaskResourceContext } from "@openpond/contracts/task-inbox";
import { ApiRequestError } from "../api/api-client";
import { sessionApi } from "../api/session-api";
import type { ClientConnection } from "../api/api-client";
import { connectionQueryScope } from "../lib/query-scope";

const INPUT_EVENTS = new Set(["task.inbox", "task.input", "task.wait", "turn.started", "turn.completed", "turn.failed", "turn.interrupted", "approval.requested", "approval.resolved"]);
type PendingIntent = { body: string; kind: "steer" | "queued"; key: string; turnId: string | null; request?: SendTurnRequest; resourceContexts?: TaskResourceContext[]; attachments?: ChatAttachment[] };

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
    refetchInterval: query => query.state.data?.inputs.some(input => input.state === "pending") ? 2000 : query.state.data?.paused ? 10000 : false,
  });
  const [operation, setOperation] = useState<{ scope: string; id: string } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const [pendingQueues, setPendingQueues] = useState<Record<string, PendingIntent>>({});
  const operationScope = `${scope}:${sessionId}`;
  const pendingQueue = pendingQueues[operationScope];
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
      queries.setQueryData<TaskInboxSnapshot>(queryKey, current => taskInboxWithReceipt(current, sessionId!, receipt));
      // The receipt is already durable. A later refresh failure must not make a successful send look unsent.
      void refresh();
      return true;
    } catch (error) {
      const durable = queries.getQueryData<typeof state.data>(queryKey)?.inputs.find(input => input.idempotencyKey === id);
      if (durable && ["pending", "included", "resolved"].includes(durable.state)) return true;
      setFailure({ scope: operationScope, message: error instanceof Error ? error.message : String(error) });
      void refresh();
      return false;
    } finally {
      setOperation((current) => current?.scope === operationScope && current.id === id ? null : current);
    }
  }

  async function send(kind: PendingIntent["kind"], body: string, request?: SendTurnRequest, resourceContexts?: TaskResourceContext[], attachments?: ChatAttachment[]): Promise<boolean> {
    if (!connection || !sessionId) return false;
    const storageKey = `openpond:task-input:${connection.serverUrl}:${sessionId}`;
    const previous = savedIntent(storageKey);
    const retrying = previous?.body === body && previous.kind === kind
      && JSON.stringify(previous.request) === JSON.stringify(request)
      && JSON.stringify(previous.resourceContexts) === JSON.stringify(resourceContexts)
      && JSON.stringify(previous.attachments) === JSON.stringify(attachments);
    const intent = retrying ? previous : {
      body, kind, request, resourceContexts, attachments, key: crypto.randomUUID(), turnId: kind === "steer" ? state.data?.activeTurnId ?? null : null,
    };
    if (kind === "steer" && (!intent.turnId || (!retrying && !state.data?.acceptingInput))) {
      setFailure({ scope: operationScope, message: "This turn is no longer accepting steering. Your text is still in the composer; send it as a follow-up or queue it." });
      void refresh(); return false;
    }
    try { sessionStorage.setItem(storageKey, JSON.stringify(intent)); } catch { /* Browser storage may be unavailable. */ }
    if (kind === "queued") setPendingQueues(current => ({ ...current, [operationScope]: intent }));
    const sent = await perform(intent.key, async () => {
      let receipt: TaskInput;
      try { receipt = await (kind === "steer"
      ? sessionApi.steerTurn(connection, sessionId, { prompt: body, expectedTurnId: intent.turnId!, idempotencyKey: intent.key, resourceContexts: intent.resourceContexts, attachments: intent.attachments })
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
    if (kind === "queued") setPendingQueues(current => {
      if (current[operationScope]?.key !== intent.key) return current;
      const next = { ...current }; delete next[operationScope]; return next;
    });
    if (sent) {
      try { if (savedIntent(storageKey)?.key === intent.key) sessionStorage.removeItem(storageKey); } catch { /* No durable browser state to clear. */ }
    }
    return sent;
  }

  const storageKey = connection && sessionId ? `openpond:task-input:${connection.serverUrl}:${sessionId}` : null;
  const retainedIntent = storageKey ? savedIntent(storageKey) : null;
  const acknowledgedInput = retainedTaskInputAcknowledgement(state.data?.inputs ?? [], retainedIntent);

  return {
    pendingQueue: pendingQueue && !state.data?.inputs.some(input => input.idempotencyKey === pendingQueue.key)
      ? { id: pendingQueue.key, body: pendingQueue.body, attachments: pendingQueue.request?.attachments ?? [] } : null,
    acknowledgedInput,
    acknowledgeRetainedInput: () => {
      if (!storageKey || !acknowledgedInput || savedIntent(storageKey)?.key !== acknowledgedInput.idempotencyKey) return;
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional browser recovery storage. */ }
      setOperation(current => current?.scope === operationScope && current.id === acknowledgedInput.idempotencyKey ? null : current);
    },
    enabled, snapshot: state.data ?? null,
    busyId: operation?.scope === operationScope ? operation.id : null,
    error: failure?.scope === operationScope ? failure.message : state.error?.message ?? null,
    steer: (body: string, resourceContexts?: TaskResourceContext[], attachments?: ChatAttachment[]) => send("steer", body, undefined, resourceContexts, attachments),
    queue: (request: SendTurnRequest) => send("queued", request.prompt, request),
    mutate: (input: TaskInput, mutation: TaskInputMutation) => perform(input.id, () => sessionApi.updateTaskInput(connection!, sessionId!, input.id, mutation)),
    refresh,
  };
}

export type TaskInboxController = ReturnType<typeof useTaskInbox>;
