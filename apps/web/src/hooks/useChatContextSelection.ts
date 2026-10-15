import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatContextSelectionSchema, ChatContextOptionSchema, type ChatContextSelection, type ChatContextTarget } from "@openpond/contracts";
import { chatResourceRequest } from "../api/chat-resource-api";
import type { ClientConnection } from "../api";
import { connectionQueryScope } from "../lib/query-scope";

export const ChatContextAccountScope = createContext("default");
export const CHAT_CONTEXT_SELECTED = "openpond-chat-context-selected";
const selections = new Map<string, ChatContextSelection | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
function publish(key: string, value: ChatContextSelection | null) { selections.set(key, value); for (const listener of listeners) listener(); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useChatContextSelection(connection: ClientConnection | null, sessionId: string | null, scopeOverride?: string) {
  const inheritedScope = useContext(ChatContextAccountScope);
  const scope = `${connection ? connectionQueryScope(connection) : "disconnected"}:${scopeOverride ?? inheritedScope}`;
  const key = `${scope}:${sessionId ?? "new"}`;
  const queries = useQueryClient();
  const staged = useSyncExternalStore(subscribe, () => selections.get(key), () => undefined);
  const selecting = useSyncExternalStore(subscribe, () => pending.has(key), () => false);
  const catalog = useQuery({ queryKey: ["chat-context-catalog", scope, sessionId], enabled: Boolean(connection), staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const result = await chatResourceRequest<{ options: unknown; warning: string | null }>(connection!, "dataset", { action: "context_catalog", payload: sessionId ? { sessionId } : {} }, signal);
      return { ...result, options: ChatContextOptionSchema.array().parse(result.options) };
    } });
  const retained = useQuery({ queryKey: ["chat-context-selection", key], enabled: Boolean(connection && sessionId && !selecting), refetchInterval: 10_000,
    queryFn: async ({ signal }) => {
      const result = await chatResourceRequest<{ selection: unknown }>(connection!, "dataset", { action: "context_selection", payload: { sessionId } }, signal);
      const value = result.selection ? ChatContextSelectionSchema.parse(result.selection) : null;
      const known = queries.getQueryData<{options: {target: ChatContextTarget}[]}>(["chat-context-catalog", scope, sessionId]);
      if (value?.target.scopeId && known && !known.options.some(item => item.target.scopeId === value.target.scopeId))
        void queries.invalidateQueries({ queryKey: ["chat-context-catalog", scope, sessionId] });
      return value;
    } });
  const selection = sessionId ? retained.data === undefined ? staged ?? null : retained.data : staged ?? null;
  useEffect(() => {
    if (!connection || !sessionId) return;
    const changed = (event: Event) => {
      if ((event as CustomEvent<{sessionId:string}>).detail?.sessionId === sessionId)
        void queries.invalidateQueries({ queryKey: ["chat-context-selection", key] });
    };
    window.addEventListener("openpond-resource-focus-changed", changed);
    return () => window.removeEventListener("openpond-resource-focus-changed", changed);
  }, [connection, sessionId, key, queries]);
  const modelTarget = selection?.training
    ? selection.training.location === "cloud"
      ? { kind: "model" as const, id: selection.training.job.modelProjectId, location: "cloud" as const, teamId: selection.training.owner.teamId, apiOrigin: selection.training.apiOrigin }
      : { kind: "model" as const, id: selection.training.modelId, location: "local" as const }
    : selection?.model ? selection.target : null;
  const runs = useQuery({ queryKey: ["chat-context-model-runs", scope, modelTarget], enabled: Boolean(connection && modelTarget),
    queryFn: async ({ signal }) => {
      const result = await chatResourceRequest<{ runs: unknown }>(connection!, "dataset", { action: "context_runs", payload: { target: modelTarget } }, signal);
      return { runs: ChatContextOptionSchema.array().parse(result.runs) };
    } });
  const select = useCallback(async (target: ChatContextTarget | null, options?: { newExperiment?: boolean }) => {
    if (!connection || pending.has(key)) return;
    pending.add(key); for (const listener of listeners) listener();
    try {
      // A read started before the user changed selection must never overwrite that selection.
      await queries.cancelQueries({ queryKey: ["chat-context-selection", key] });
      const result = await chatResourceRequest<{ selection: unknown }>(connection, "dataset", { action: "context_select", payload: { target, ...(options?.newExperiment ? { newExperiment: true } : {}), ...(sessionId ? { sessionId } : {}) } });
      const value = result.selection ? ChatContextSelectionSchema.parse(result.selection) : null;
      await queries.cancelQueries({ queryKey: ["chat-context-selection", key] });
      publish(key, value);
      if (sessionId) queries.setQueryData(["chat-context-selection", key], value);
      if (options?.newExperiment) void queries.invalidateQueries({ queryKey: ["chat-context-catalog", scope, sessionId] });
      if (sessionId) window.dispatchEvent(new CustomEvent("openpond-resource-focus-changed", { detail: { sessionId } }));
      if (value) window.dispatchEvent(new CustomEvent(CHAT_CONTEXT_SELECTED, { detail: { sessionId, scope, targetKey: JSON.stringify(value.target) } }));
    } finally { pending.delete(key); for (const listener of listeners) listener(); }
  }, [connection, key, queries, scope, sessionId]);
  const moveToSession = useCallback((id: string) => {
    const value = selections.get(key);
    if (value !== undefined) {
      publish(`${scope}:${id}`, value);
      queries.setQueryData(["chat-context-selection", `${scope}:${id}`], value);
    }
    if (!sessionId) publish(key, null);
  }, [key, scope, queries, sessionId]);
  return { selection, selecting, catalog, runs, select, selectionError: retained.error, moveToSession, scope };
}
