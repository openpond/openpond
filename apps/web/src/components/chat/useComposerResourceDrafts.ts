import type { ComposerDraftStore } from "../../lib/composer-draft-store";
import { useCallback, useRef } from "react";
import type { TaskResourceContext } from "@openpond/contracts";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { captureComposerResourceContext } from "./composer-resource-context";

/** Bind action targets to the conversation draft, independently of bar selection. */
export function useComposerResourceDrafts(
  scopeKey: string,
  changePrompt: (value: string) => void,
  resources: ReturnType<typeof useChatResourceFocus>,
  store?: ComposerDraftStore,
) {
  const localDrafts = useRef(new Map<string, TaskResourceContext[]>());
  const contexts = store?.resourceContexts;
  const resourceDrafts = {current: contexts ? {
    get: (key: string) => contexts.get(`session:${key}`),
    set: (key: string, value: TaskResourceContext[]) => contexts.set(`session:${key}`, value),
    delete: (key: string) => contexts.delete(`session:${key}`),
  } : localDrafts.current};
  const onPromptChange = useCallback((value: string) => {
    if (!value.trim()) resourceDrafts.current.delete(scopeKey);
    changePrompt(value);
  }, [changePrompt, scopeKey, contexts]);
  function currentResourceContexts() {
    return resourceDrafts.current.get(scopeKey) ?? captureComposerResourceContext(resources);
  }
  return { resourceDrafts, onPromptChange, currentResourceContexts };
}
