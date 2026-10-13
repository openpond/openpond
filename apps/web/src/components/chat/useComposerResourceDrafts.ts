import { useCallback, useRef } from "react";
import type { TaskResourceContext } from "@openpond/contracts";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { captureComposerResourceContext } from "./composer-resource-context";

/** Bind action targets to the conversation draft, independently of bar selection. */
export function useComposerResourceDrafts(
  scopeKey: string,
  changePrompt: (value: string) => void,
  resources: ReturnType<typeof useChatResourceFocus>,
) {
  const resourceDrafts = useRef(new Map<string, TaskResourceContext[]>());
  const onPromptChange = useCallback((value: string) => {
    if (!value.trim()) resourceDrafts.current.delete(scopeKey);
    changePrompt(value);
  }, [changePrompt, scopeKey]);
  function currentResourceContexts() {
    return resourceDrafts.current.get(scopeKey) ?? captureComposerResourceContext(resources);
  }
  return { resourceDrafts, onPromptChange, currentResourceContexts };
}
