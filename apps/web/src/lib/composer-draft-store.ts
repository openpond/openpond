import { useSyncExternalStore, type SetStateAction } from "react";
import type { AppAction, AppState } from "../app/app-state";

type PromptSelection = Pick<AppState, "selectedAppId" | "selectedProjectId" | "selectedSessionId">;

export type ComposerDraftStore = {
  applyAppAction: (action: AppAction) => void;
  getScopeKey: () => string;
  getSnapshot: () => string;
  set: (value: SetStateAction<string>) => void;
  setForScope: (scopeKey: string, value: SetStateAction<string>) => void;
  subscribe: (listener: () => void) => () => void;
};

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
): ComposerDraftStore {
  let selection = initialSelection;
  let value = "";
  const drafts = new Map<string, string>();
  const listeners = new Set<() => void>();

  const publish = (nextValue: string) => {
    if (Object.is(value, nextValue)) return;
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
    saveCurrent();
    selection = { ...selection, ...patch };
    const key = draftKey(selection);
    if (options.clear) drafts.delete(key);
    if (options.preserveCurrentDraft) {
      if (currentValue) drafts.set(key, currentValue);
      else drafts.delete(key);
      publish(currentValue);
      return;
    }
    publish(options.clear ? "" : (drafts.get(key) ?? ""));
  };

  const store: ComposerDraftStore = {
    getScopeKey: () => draftKey(selection),
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => store.setForScope(draftKey(selection), next),
    setForScope(scopeKey, next) {
      const activeScopeKey = draftKey(selection);
      const current =
        scopeKey === activeScopeKey ? value : (drafts.get(scopeKey) ?? "");
      const resolved = typeof next === "function" ? next(current) : next;
      if (Object.is(current, resolved)) return;
      if (resolved) drafts.set(scopeKey, resolved);
      else drafts.delete(scopeKey);
      if (scopeKey === activeScopeKey) publish(resolved);
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
          { selectedSessionId: null, selectedAppId: action.appId, selectedProjectId: null },
          { clear: true },
        );
      }
    },
  };
  return store;
}

export function useComposerDraft(store: ComposerDraftStore): string {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
