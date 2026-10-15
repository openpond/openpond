import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChatContextSelectionSchema, type ChatContextOption, type ChatContextSelection, type ChatContextTarget } from "@openpond/contracts";
import { chatResourceRequest } from "../api/chat-resource-api";
import type { ClientConnection } from "../api";
import { connectionQueryScope } from "../lib/query-scope";

export const ChatContextAccountScope = createContext("default");
const selections = new Map<string, ChatContextSelection | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
function publish(key: string, value: ChatContextSelection | null) { selections.set(key, value); for (const listener of listeners) listener(); }
export function useChatContextSelection(connection: ClientConnection | null, sessionId: string | null) {
  const accountScope = useContext(ChatContextAccountScope);
  const scope = `${connection ? connectionQueryScope(connection) : "disconnected"}:${accountScope}`;
  const key = `${scope}:${sessionId ?? "new"}`;
  const selection = useSyncExternalStore(useCallback(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []),
    () => selections.get(key), () => undefined);
  const selecting = useSyncExternalStore(useCallback(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []), () => pending.has(key), () => false);
  const catalog = useQuery({ queryKey: ["chat-context-catalog", scope], enabled: Boolean(connection), staleTime: 30_000, refetchOnMount: "always",
    queryFn: ({ signal }) => chatResourceRequest<{ options: ChatContextOption[]; warning: string | null }>(connection!, "dataset", { action: "context_catalog" }, signal) });
  const retained = useQuery({ queryKey: ["chat-context-selection", key], enabled: Boolean(connection && sessionId && selection === undefined),
    queryFn: async ({ signal }) => {
      const result = await chatResourceRequest<{ selection: unknown }>(connection!, "dataset", { action: "context_selection", payload: { sessionId } }, signal);
      const value = result.selection ? ChatContextSelectionSchema.parse(result.selection) : null;
      publish(key, value); return value;
    } });
  const modelTarget = selection?.training
    ? selection.training.location === "cloud"
      ? { kind: "model" as const, id: selection.training.job.modelProjectId, location: "cloud" as const, teamId: selection.training.owner.teamId, apiOrigin: selection.training.apiOrigin }
      : { kind: "model" as const, id: selection.training.modelId, location: "local" as const }
    : selection?.model ? selection.target : null;
  const runs = useQuery({ queryKey: ["chat-context-model-runs", scope, modelTarget?.id, modelTarget?.location], enabled: Boolean(connection && modelTarget),
    queryFn: ({ signal }) => chatResourceRequest<{ runs: ChatContextOption[] }>(connection!, "dataset", { action: "context_runs", payload: { target: modelTarget } }, signal) });
  async function select(target: ChatContextTarget | null) {
    if (!connection || pending.has(key)) return;
    pending.add(key); for (const listener of listeners) listener();
    try {
    const result = await chatResourceRequest<{ selection: unknown }>(connection, "dataset", { action: "context_select", payload: { target, ...(sessionId ? { sessionId } : {}) } });
    publish(key, result.selection ? ChatContextSelectionSchema.parse(result.selection) : null);
    if (sessionId) window.dispatchEvent(new CustomEvent("openpond-resource-focus-changed", { detail: { sessionId } }));
    } finally { pending.delete(key); for (const listener of listeners) listener(); }
  }
  return { selection: selection === undefined ? retained.data ?? null : selection, selecting, catalog, runs, select, selectionError: retained.error,
    moveToSession(id: string) { const value = selections.get(key); if (value !== undefined) publish(`${scope}:${id}`, value); if (!sessionId) publish(key, null); },
  };
}
