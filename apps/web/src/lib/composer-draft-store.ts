import { TaskResourceContextsSchema, type TaskResourceContext } from "@openpond/contracts";
import { useSyncExternalStore, type SetStateAction } from "react";
import type { AppAction, AppState } from "../app/app-state";
import { DecisionChatDraftSchema, DecisionChatDraftsSchema, type DecisionChatDraft } from "./decision-chat-draft";
import { ResourceSetupDraftSchema, type ResourceSetupDraft } from "@openpond/contracts/resource-setup";

export type StoredComposerDraft = string | {
  prompt: string;
  resourceContexts: TaskResourceContext[];
  decisionInputs?: Record<string, DecisionChatDraft>;
  resourceSetup?: ResourceSetupDraft;
};

type PromptSelection = Pick<AppState, "selectedAppId" | "selectedProjectId" | "selectedSessionId">;

export type ComposerDraftStore = {
  applyAppAction: (action: AppAction) => void;
  getScopeKey: () => string;
  getSnapshot: () => string;
  getDrafts: () => Record<string, StoredComposerDraft>;
  resourceContexts: Map<string, TaskResourceContext[]>;
  set: (value: SetStateAction<string>) => void;
  setForScope: (scopeKey: string, value: SetStateAction<string>) => void;
  getDecisionDraft: (scopeKey: string, modelId: string) => DecisionChatDraft | null;
  setDecisionDraftForScope: (scopeKey: string, modelId: string, value: DecisionChatDraft | null) => void;
  getResourceSetup(scopeKey: string): ResourceSetupDraft | null;
  setResourceSetup(scopeKey: string, update: (current: ResourceSetupDraft | null) => ResourceSetupDraft | null, consumePrompt?: string): void;
  subscribe: (listener: () => void) => () => void;
};

// Session creation can switch the active draft before the send is accepted.
// Consume only the originating draft, and leave edits made during the request.
export function captureSubmittedDraftClear(store: ComposerDraftStore): () => boolean {
  const scopeKey = store.getScopeKey();
  const submitted = store.getSnapshot();
  return () => {
    let cleared = false;
    store.setForScope(scopeKey, current => {
      if (current !== submitted) return current;
      cleared = true;
      return "";
    });
    return cleared && store.getScopeKey() === scopeKey;
  };
}

function draftKey(selection: PromptSelection): string {
  if (selection.selectedSessionId) return `session:${selection.selectedSessionId}`;
  if (selection.selectedProjectId) return `project:${selection.selectedProjectId}`;
  if (selection.selectedAppId) return `app:${selection.selectedAppId}`;
  return "new-chat";
}

export function createComposerDraftStore(
  initialSelection: PromptSelection = {
    selectedAppId: null,
    selectedProjectId: null,
    selectedSessionId: null,
  },
  initialDrafts: Record<string, StoredComposerDraft> = {},
): ComposerDraftStore {
  let selection = initialSelection;
  const resourceContexts = new Map<string, TaskResourceContext[]>();
  const decisionInputs = new Map<string, Record<string, DecisionChatDraft>>();
  const resourceSetups = new Map<string, ResourceSetupDraft>();
  const drafts = new Map(Object.entries(initialDrafts).map(([key, entry]) => {
    if (typeof entry === "string") return [key, entry] as const;
    const parsed = TaskResourceContextsSchema.safeParse(entry.resourceContexts);
    if (parsed.success) resourceContexts.set(key, parsed.data);
    const decisions = DecisionChatDraftsSchema.safeParse(entry.decisionInputs);
    if (decisions.success && Object.keys(decisions.data).length) decisionInputs.set(key, decisions.data);
    const setup = ResourceSetupDraftSchema.safeParse(entry.resourceSetup);
    if (setup.success) resourceSetups.set(key, setup.data);
    return [key, entry.prompt] as const;
  }));
  let value = drafts.get(draftKey(selection)) ?? "";
  const listeners = new Set<() => void>();

  const publish = (nextValue: string, scopeChanged = false) => {
    if (!scopeChanged && Object.is(value, nextValue)) return;
    value = nextValue;
    for (const listener of listeners) listener();
  };
  const saveCurrent = () => {
    const key = draftKey(selection);
    if (value) drafts.set(key, value);
    else drafts.delete(key);
  };
  const select = (
    patch: Partial<PromptSelection>,
    options: { clear?: boolean; preserveCurrentDraft?: boolean } = {},
  ) => {
    const currentValue = value;
    const currentKey = draftKey(selection);
    saveCurrent();
    selection = { ...selection, ...patch };
    const key = draftKey(selection);
    if (options.clear) { drafts.delete(key); resourceContexts.delete(key); }
    if (options.preserveCurrentDraft) {
      if (currentValue) drafts.set(key, currentValue);
      else drafts.delete(key);
      publish(currentValue, currentKey !== key);
      return;
    }
    publish(options.clear ? "" : (drafts.get(key) ?? ""), currentKey !== key);
  };

  const store: ComposerDraftStore = {
    getScopeKey: () => draftKey(selection),
    getSnapshot: () => value,
    resourceContexts,
    getDrafts: () => {
      saveCurrent();
      return Object.fromEntries([...new Set([...drafts.keys(), ...decisionInputs.keys(), ...resourceSetups.keys()])].map(key => {
        const prompt = drafts.get(key) ?? "", decisions = decisionInputs.get(key), resourceSetup = resourceSetups.get(key);
        return [key, resourceContexts.has(key) || decisions || resourceSetup ? {
          prompt, resourceContexts: structuredClone(resourceContexts.get(key) ?? []),
          ...(decisions ? { decisionInputs: structuredClone(decisions) } : {}),
          ...(resourceSetup ? { resourceSetup: structuredClone(resourceSetup) } : {}),
        } : prompt];
      }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => store.setForScope(draftKey(selection), next),
    getDecisionDraft(scopeKey, modelId) {
      const value = decisionInputs.get(scopeKey)?.[modelId];
      return value ? structuredClone(value) : null;
    },
    setDecisionDraftForScope(scopeKey, modelId, value) {
      DecisionChatDraftsSchema.keyType.parse(modelId);
      const current = { ...decisionInputs.get(scopeKey) };
      if (value) current[modelId] = DecisionChatDraftSchema.parse(value);
      else delete current[modelId];
      if (Object.keys(current).length) decisionInputs.set(scopeKey, current);
      else decisionInputs.delete(scopeKey);
      for (const listener of listeners) listener();
    },
    getResourceSetup: scopeKey => resourceSetups.get(scopeKey) ?? null,
    setResourceSetup(scopeKey, update, consumePrompt) {
      const current = store.getResourceSetup(scopeKey);
      const next = update(current);
      if (current === next) return;
      if (next) resourceSetups.set(scopeKey, ResourceSetupDraftSchema.parse(next));
      else resourceSetups.delete(scopeKey);
      // The resource body now contains the ordinary prompt. Consume both in one
      // notification, keeping the attachments and resource contexts for this scope.
      if (consumePrompt && (scopeKey === draftKey(selection) ? value : drafts.get(scopeKey)) === consumePrompt) {
        drafts.delete(scopeKey);
        if (scopeKey === draftKey(selection)) value = "";
      }
      for (const listener of listeners) listener();
    },
    setForScope(scopeKey, next) {
      const activeScopeKey = draftKey(selection);
      const current =
        scopeKey === activeScopeKey ? value : (drafts.get(scopeKey) ?? "");
      const resolved = typeof next === "function" ? next(current) : next;
      if (!resolved.trim()) resourceContexts.delete(scopeKey);
      if (Object.is(current, resolved)) return;
      if (resolved) drafts.set(scopeKey, resolved);
      else drafts.delete(scopeKey);
      if (scopeKey === activeScopeKey) publish(resolved);
      else for (const listener of listeners) listener();
    },
    applyAppAction(action) {
      if (action.type === "field") {
        if (action.key === "prompt") {
          store.set(action.value as SetStateAction<string>);
          return;
        }
        if (
          action.key === "selectedAppId" ||
          action.key === "selectedProjectId" ||
          action.key === "selectedSessionId"
        ) {
          const current = selection[action.key];
          const next = typeof action.value === "function"
            ? (action.value as (current: string | null) => string | null)(current)
            : action.value as string | null;
          if (!Object.is(current, next)) select({ [action.key]: next });
        }
        return;
      }
      if (action.type === "patch") {
        const patch: Partial<PromptSelection> = {};
        if ("selectedAppId" in action.patch) patch.selectedAppId = action.patch.selectedAppId;
        if ("selectedProjectId" in action.patch) patch.selectedProjectId = action.patch.selectedProjectId;
        if ("selectedSessionId" in action.patch) patch.selectedSessionId = action.patch.selectedSessionId;
        if (Object.keys(patch).length > 0) select(patch);
        if ("prompt" in action.patch && typeof action.patch.prompt === "string") store.set(action.patch.prompt);
        return;
      }
      if (action.type === "selectApp") {
        select({ selectedAppId: action.appId, selectedProjectId: null, selectedSessionId: null });
        return;
      }
      if (action.type === "selectProject") {
        select(
          { selectedAppId: null, selectedProjectId: action.projectId, selectedSessionId: null },
          { preserveCurrentDraft: true },
        );
        return;
      }
      if (action.type === "selectSession") {
        const projectId = action.projectId ?? null;
        select({
          selectedSessionId: action.sessionId,
          selectedAppId: projectId ? null : (action.appId ?? null),
          selectedProjectId: projectId,
        });
        return;
      }
      if (action.type === "beginNewChat") {
        select(
          { selectedSessionId: null, selectedAppId: action.appId, selectedProjectId: action.projectId ?? null },
        );
      }
    },
  };
  return store;
}

export function useComposerDraft(store: ComposerDraftStore): string {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useResourceSetupDraft(store: ComposerDraftStore, scopeKey: string): ResourceSetupDraft | null {
  return useSyncExternalStore(store.subscribe, () => store.getResourceSetup(scopeKey), () => null);
}
