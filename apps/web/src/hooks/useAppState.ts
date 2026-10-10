import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import {
  appReducer,
  createAppSetters,
  initialAppState,
  type AppAction,
} from "../app/app-state";
import { createComposerDraftStore } from "../lib/composer-draft-store";
import { clearDesktopUpdateDrafts, restoreDesktopUpdateDrafts, saveDesktopUpdateDrafts } from "../lib/desktop-update-drafts";

export function useAppState() {
  const [state, rawDispatch] = useReducer(
    appReducer,
    initialAppState
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
  return { composerDraftStore, dispatch, setters, state };
}
