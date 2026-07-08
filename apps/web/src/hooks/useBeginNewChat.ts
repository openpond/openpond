import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { OpenPondApp } from "@openpond/contracts";
import type { AppAction } from "../app/app-state";
import { projectSelectionKey } from "../lib/app-models";

function focusNewChatComposer() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLElement>(
        ".main-pane .composer-stack.start .composer-inline-input, .main-pane .composer-stack.dock .composer-inline-input",
      );
      if (!input) return;
      input.focus();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  });
}

export function useBeginNewChat({
  appDispatch,
  expandProject,
  linkedProjectByAppId,
  setMentionedAppId,
}: {
  appDispatch: Dispatch<AppAction>;
  expandProject: (projectId: string) => void;
  linkedProjectByAppId: Map<string, string>;
  setMentionedAppId: Dispatch<SetStateAction<string | null>>;
}) {
  return useCallback(
    (app: OpenPondApp | null = null) => {
      const linkedProjectId = app?.id ? (linkedProjectByAppId.get(app.id) ?? null) : null;
      if (linkedProjectId) {
        const projectKey = projectSelectionKey("local", linkedProjectId);
        setMentionedAppId(null);
        appDispatch({ type: "selectProject", projectId: projectKey });
        expandProject(projectKey);
        return;
      }
      setMentionedAppId(null);
      appDispatch({ type: "beginNewChat", appId: app?.id ?? null });
      focusNewChatComposer();
    },
    [appDispatch, expandProject, linkedProjectByAppId, setMentionedAppId],
  );
}
