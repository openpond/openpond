import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import {
  appReducer,
  createAppSetters,
  initialAppState,
  type AppAction,
} from "../app/app-state";
import { createComposerDraftStore } from "../lib/composer-draft-store";
import { restoreDesktopUpdateDrafts, saveDesktopUpdateDrafts } from "../lib/desktop-update-drafts";

export function useAppState() {
  const [state, rawDispatch] = useReducer(
    appReducer,
    initialAppState
  );
  const [composerDraftStore] = useState(() => createComposerDraftStore(undefined, restoreDesktopUpdateDrafts()));
  useEffect(() => {
    // Keep recovery durable until an authoritative save replaces it, including
    // an empty snapshot after drafts are cleared or sent.
    const persistDrafts = () => saveDesktopUpdateDrafts(composerDraftStore.getDrafts());
    const reportSaveFailure = () => rawDispatch({ type: "showToast", toast: {
      id: Date.now(), createdAt: Date.now(), tone: "error",
      message: "Unsent drafts could not be saved on this device.",
      dedupeKey: "composer-draft-recovery", actionLabel: "Retry",
      onAction: () => { persistDrafts(); return true; },
    } });
    const saveBeforeExit = (event: Event) => {
      try { persistDrafts(); }
      catch { reportSaveFailure(); event.preventDefault(); }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = composerDraftStore.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { persistDrafts(); }
        catch { reportSaveFailure(); }
      }, 500);
    });
    window.addEventListener("openpond:before-update", saveBeforeExit);
    window.addEventListener("beforeunload", saveBeforeExit);
    window.addEventListener("pagehide", saveBeforeExit);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("openpond:before-update", saveBeforeExit);
      window.removeEventListener("beforeunload", saveBeforeExit);
      window.removeEventListener("pagehide", saveBeforeExit);
    };
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
