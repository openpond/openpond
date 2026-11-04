import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { canonicalJson, ExperimentDraftSchema, type ExperimentDraft, type ExperimentDraftRecord, type ExperimentDraftSave } from "openpond-sdk/training";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatContextSelectionSchema, ChatContextOptionSchema, type ChatContextSelection, type ChatContextTarget } from "@openpond/contracts";
import { chatResourceRequest } from "../api/chat-resource-api";
import type { ClientConnection } from "../api";
import { connectionQueryScope } from "../lib/query-scope";
import { ChatExperimentWorkspaceContext } from "../components/chat/ChatExperimentWorkspaceContext";
import { requestDesktopViewChange } from "../components/labs/lab-primary-tab-state";

export const ChatContextAccountScope = createContext("default");
export const CHAT_CONTEXT_SELECTED = "openpond-chat-context-selected";
const selections = new Map<string, ChatContextSelection | null>();
const pending = new Set<string>();
const configureDrafts = new Map<string, string>();
const listeners = new Set<() => void>();
function publish(key: string, value: ChatContextSelection | null) { selections.set(key, value); for (const listener of listeners) listener(); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useChatContextSelection(connection: ClientConnection | null, sessionId: string | null, scopeOverride?: string) {
  const inheritedScope = useContext(ChatContextAccountScope);
  const workspace = useContext(ChatExperimentWorkspaceContext);
  const scope = `${connection ? connectionQueryScope(connection) : "disconnected"}:${scopeOverride ?? inheritedScope}`;
  const key = `${scope}:${sessionId ?? "new"}`;
  const activeKey = useRef(key); activeKey.current = key;
  const queries = useQueryClient();
  const pendingDraftSave = useRef<{ key: string; target: ChatContextTarget; update: ExperimentDraftSave } | null>(null);
  const staged = useSyncExternalStore(subscribe, () => selections.get(key), () => undefined);
  const selecting = useSyncExternalStore(subscribe, () => pending.has(key), () => false);
  const configureDraftId = useSyncExternalStore(subscribe, () => configureDrafts.get(key) ?? null, () => null);
  const catalogPages = useInfiniteQuery({ queryKey: ["chat-context-catalog", "pages", scope, sessionId], enabled: Boolean(connection), staleTime: 30_000,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: { nextDraftCursor: string | null }) => page.nextDraftCursor ?? undefined,
    queryFn: async ({ signal, pageParam }) => {
      const result = await chatResourceRequest<{ options: unknown; warning: string | null; nextDraftCursor: string | null }>(connection!, "dataset", {
        action: "context_catalog", payload: { ...(sessionId ? { sessionId } : {}), ...(pageParam ? { draftCursor: pageParam } : {}) },
      }, signal);
      return { ...result, options: ChatContextOptionSchema.array().parse(result.options) };
    } });
  const catalog = { ...catalogPages, data: useMemo(() => catalogPages.data ? {
    options: [...new Map(catalogPages.data.pages.flatMap(page => page.options).map(option => [canonicalJson(option.target), option])).values()],
    warning: [...new Set(catalogPages.data.pages.map(page => page.warning).filter(Boolean))].join(" ") || null,
  } : undefined, [catalogPages.data]) };
  const retained = useQuery({ queryKey: ["chat-context-selection", key], enabled: Boolean(connection && sessionId && !selecting), refetchInterval: 10_000,
    queryFn: async ({ signal }) => {
      const result = await chatResourceRequest<{ selection: unknown }>(connection!, "dataset", { action: "context_selection", payload: { sessionId } }, signal);
      const value = result.selection ? ChatContextSelectionSchema.parse(result.selection) : null;
      const known = queries.getQueryData<{pages: {options: {target: ChatContextTarget}[]}[]}>(["chat-context-catalog", "pages", scope, sessionId]);
      if (value?.target.scopeId && known && !known.pages.some(page => page.options.some(item => item.target.scopeId === value.target.scopeId)))
        void queries.invalidateQueries({ queryKey: ["chat-context-catalog", "pages", scope, sessionId] });
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
    if (!connection) throw new Error("Connect before selecting experiment context.");
    if (pending.has(key)) throw new Error("Wait for the current context selection to finish.");
    let approved = false;
    await requestDesktopViewChange(() => { approved = true; });
    if (!approved || activeKey.current !== key) return false;
    if (pending.has(key)) throw new Error("Wait for the current context selection to finish.");
    pending.add(key); for (const listener of listeners) listener();
    try {
      // A read started before the user changed selection must never overwrite that selection.
      await queries.cancelQueries({ queryKey: ["chat-context-selection", key] });
      const result = await chatResourceRequest<{ selection: unknown }>(connection, "dataset", { action: "context_select", payload: { target, ...(options?.newExperiment ? { newExperiment: true } : {}), ...(sessionId ? { sessionId } : {}) } });
      const value = result.selection ? ChatContextSelectionSchema.parse(result.selection) : null;
      if (activeKey.current !== key) return false;
      if (options?.newExperiment && value?.draft) configureDrafts.set(key, value.draft.id);
      else configureDrafts.delete(key);
      await queries.cancelQueries({ queryKey: ["chat-context-selection", key] });
      publish(key, value);
      if (sessionId) queries.setQueryData(["chat-context-selection", key], value);
      if (options?.newExperiment) void queries.invalidateQueries({ queryKey: ["chat-context-catalog", "pages", scope, sessionId] });
      if (sessionId) window.dispatchEvent(new CustomEvent("openpond-resource-focus-changed", { detail: { sessionId } }));
      if (value) window.dispatchEvent(new CustomEvent(CHAT_CONTEXT_SELECTED, { detail: { sessionId, scope, targetKey: JSON.stringify(value.target) } }));
      return true;
    } finally { pending.delete(key); for (const listener of listeners) listener(); }
  }, [connection, key, queries, scope, sessionId]);
  const associateTraining = useCallback(async (jobId: string, apiOrigin: string, draftId: string) => {
    if (!connection || !workspace?.teamId) throw new Error("The originating account is unavailable.");
    await queries.cancelQueries({ queryKey: ["chat-context-selection", key] });
    const result = await chatResourceRequest<{ selection: unknown }>(connection, "dataset", {
      action: "context_select", payload: { target: { kind: "training", id: jobId, location: "cloud",
        teamId: workspace.teamId, apiOrigin }, ...(sessionId ? { sessionId, sourceDraftId: draftId } : {}) },
    });
    const value = result.selection ? ChatContextSelectionSchema.parse(result.selection) : null;
    if (activeKey.current !== key) return;
    configureDrafts.delete(key); publish(key, value);
    if (sessionId) queries.setQueryData(["chat-context-selection", key], value);
    if (sessionId) window.dispatchEvent(new CustomEvent("openpond-resource-focus-changed", { detail: { sessionId } }));
  }, [connection, workspace?.teamId, key, sessionId, queries]);
  const moveToSession = useCallback((id: string) => {
    const value = selections.get(key);
    if (value !== undefined) {
      const configuring = configureDrafts.get(key);
      if (configuring) configureDrafts.set(`${scope}:${id}`, configuring);
      publish(`${scope}:${id}`, value);
      queries.setQueryData(["chat-context-selection", `${scope}:${id}`], value);
    }
    if (!sessionId) { configureDrafts.delete(key); publish(key, null); }
  }, [key, scope, queries, sessionId]);
  const saveDraft = useCallback(async (raw: ExperimentDraft, base?: ExperimentDraftRecord | null) => {
    if (selection?.draft?.hostedEvaluationForm)
      throw new Error("Open this saved evaluation in its hosted editor to preserve its native settings.");
    const draft = ExperimentDraftSchema.parse(raw);
    if (!connection || !selection?.draft || selection.draft.id !== draft.id || !workspace?.teamId)
      throw new Error("Reopen the intended experiment in an OpenPond workspace before saving settings.");
    if (pending.has(key)) throw new Error("Wait for the current experiment action to finish.");
    pending.add(key); for (const listener of listeners) listener();
    try {
      await queries.cancelQueries({ queryKey: ["chat-context-selection", key] });
      async function write(input: NonNullable<typeof pendingDraftSave.current>) {
        const response = await chatResourceRequest<{ saved: unknown; currentSaved: unknown; selection: unknown }>(connection!, "dataset", {
          action: "context_save_draft", payload: { ...(sessionId ? { sessionId } : {}), target: input.target, update: input.update },
        });
        return { saved: ChatContextSelectionSchema.parse(response.saved), currentSaved: ChatContextSelectionSchema.parse(response.currentSaved),
          focused: response.selection ? ChatContextSelectionSchema.parse(response.selection) : null };
      }
      let record = base === undefined ? selection.storedDraft ?? null : base;
      let result: Awaited<ReturnType<typeof write>> | null = null;
      if (pendingDraftSave.current?.key === key) {
        result = await write(pendingDraftSave.current);
        record = result.saved.storedDraft ?? null;
        pendingDraftSave.current = null;
      }
      if (activeKey.current !== key) throw new Error("The active chat or account changed. The draft remains in Experiments.");
      if (!result || !record || canonicalJson(record.draft) !== canonicalJson(draft)) {
        pendingDraftSave.current = { key, target: selection.target, update: {
          schemaVersion: "openpond.experimentDraftSave.v1", teamId: workspace.teamId, projectId: record?.projectId ?? null,
          operationId: `draft-save-${crypto.randomUUID()}`, expectedRevision: record?.revision ?? 0, draft,
        } };
        result = await write(pendingDraftSave.current);
        pendingDraftSave.current = null;
      }
      if (!result.saved.storedDraft || canonicalJson(result.saved.draft) !== canonicalJson(draft) ||
          result.currentSaved.storedDraft?.contentHash !== result.saved.storedDraft.contentHash)
        throw new Error("This experiment changed elsewhere. Your edits are still here; reopen the saved draft to load its current settings.");
      if (activeKey.current !== key) return result.saved;
      await queries.cancelQueries({ queryKey: ["chat-context-selection", key] });
      publish(key, result.focused);
      if (sessionId) queries.setQueryData(["chat-context-selection", key], result.focused);
      void queries.invalidateQueries({ queryKey: ["chat-context-catalog", "pages", scope, sessionId] });
      void queries.invalidateQueries({ queryKey: ["unified-experiments"] });
      if (sessionId) window.dispatchEvent(new CustomEvent("openpond-resource-focus-changed", { detail: { sessionId } }));
      return result.saved;
    } finally { pending.delete(key); for (const listener of listeners) listener(); }
  }, [connection, selection, workspace?.teamId, key, queries, scope, sessionId]);
  const closeDraftEditor = useCallback(() => { configureDrafts.delete(key); for (const listener of listeners) listener(); }, [key]);
  return { associateTraining, selection, selecting, configureDraftId, closeDraftEditor, catalog, runs, select, saveDraft, selectionError: retained.error, moveToSession, scope };
}
