import { useCallback, useMemo, useReducer, useState, type Dispatch } from "react";
import {
  appReducer,
  createAppSetters,
  initialAppState,
  type AppAction,
} from "../app/app-state";
import { createComposerDraftStore } from "../lib/composer-draft-store";

export function useAppState() {
  const [state, rawDispatch] = useReducer(appReducer, initialAppState);
  const [composerDraftStore] = useState(() => createComposerDraftStore());
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
