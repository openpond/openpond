import { useHydratedClientChoice } from "../lib/client-choice-storage";
import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import {
  appReducer,
  createAppSetters,
  initialAppState,
  type AppState,
  type AppAction,
} from "../app/app-state";
import { createComposerDraftStore } from "../lib/composer-draft-store";
import { readLastChatTaskModeFromBrowser } from "../lib/product-area";
import { clearDesktopUpdateDrafts, restoreDesktopUpdateDrafts, saveDesktopUpdateDrafts } from "../lib/desktop-update-drafts";

function restoreInitialAppState(base: AppState): AppState {
  return {
    ...base,
    draftExperience: readLastChatTaskModeFromBrowser(),
  };
}

export function useAppState() {
  const [state, rawDispatch] = useReducer(
    appReducer,
    initialAppState,
    restoreInitialAppState
  );
  const [composerDraftStore] = useState(() => createComposerDraftStore(undefined, restoreDesktopUpdateDrafts()));
  useEffect(() => {
    // Consume after mounting, not in the initializer (StrictMode calls it twice).
    try { clearDesktopUpdateDrafts(); } catch { /* Restored drafts remain usable. */ }
    const saveBeforeUpdate = (event: Event) => {
      try { saveDesktopUpdateDrafts(composerDraftStore.getDrafts()); }
      catch { event.preventDefault(); }
    };
    window.addEventListener("openpond:before-update", saveBeforeUpdate);
    return () => window.removeEventListener("openpond:before-update", saveBeforeUpdate);
  }, [composerDraftStore]);
  const dispatch = useCallback<Dispatch<AppAction>>((action) => {
    composerDraftStore.applyAppAction(action);
    rawDispatch(action);
  }, [composerDraftStore]);
  const setters = useMemo(
    () => ({ ...createAppSetters(dispatch), setPrompt: composerDraftStore.set }),
    [composerDraftStore, dispatch],
  );
  useHydratedClientChoice(() => setters.setDraftExperience(readLastChatTaskModeFromBrowser()));
  return { composerDraftStore, dispatch, setters, state };
}
