import { useEffect, type RefObject } from "react";
import type { TaskResourceContext } from "@openpond/contracts";
import type { ComposerProps } from "./composer-types";
import type { ComposerInlineInputHandle } from "./ComposerInlineInput";
import { mergeComposerResourceContexts } from "./composer-resource-context";
import { COMPOSER_RESOURCE_REQUEST, type ComposerResourceRequest } from "./composer-resource-request";

type RequestOptions = Pick<ComposerProps, "surface" | "voiceInputChannelKey" | "taskSessionId" | "submissionScopeKey" | "prompt" | "showToast" | "composerDraftStore"> & {
  onPromptChange: (value: string) => void;
  resourceDrafts: { current: Pick<Map<string, TaskResourceContext[]>, "get" | "set" | "delete"> };
  inputRef: RefObject<ComposerInlineInputHandle | null>;
};

export function useComposerResourceRequests({ surface, voiceInputChannelKey = "", taskSessionId, submissionScopeKey = "default", prompt, onPromptChange, showToast, resourceDrafts, inputRef, composerDraftStore }: RequestOptions) {
  useEffect(() => {
    if (surface !== "chat" || !voiceInputChannelKey.startsWith("main-composer:")) return;
    const receive = (event: Event) => {
      const request = (event as CustomEvent<ComposerResourceRequest>).detail;
      if (request?.sessionId !== (taskSessionId ?? null) || !request.text.trim()) return;
      try {
        resourceDrafts.current.set(submissionScopeKey, mergeComposerResourceContexts(resourceDrafts.current.get(submissionScopeKey) ?? [], request.contexts));
      } catch {
        showToast("Send or clear the current resource actions before adding more.", "info");
        return;
      }
      const existing = inputRef.current?.getPrompt() ?? prompt;
      const next = existing.trim() ? `${existing}\n\n${request.text}` : request.text;
      onPromptChange(next);
      requestAnimationFrame(() => inputRef.current?.focusAtPromptIndex(next.length));
    };
    window.addEventListener(COMPOSER_RESOURCE_REQUEST, receive);
    return () => window.removeEventListener(COMPOSER_RESOURCE_REQUEST, receive);
  }, [surface, voiceInputChannelKey, taskSessionId, submissionScopeKey, prompt, onPromptChange, showToast, composerDraftStore]);
}
