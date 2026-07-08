import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { OpenPondApp } from "@openpond/contracts";
import type { AppAction } from "../app/app-state";
import { projectSelectionKey } from "../lib/app-models";

export function useBeginNewChat({
  appDispatch,
  expandProject,
  linkedProjectByAppId,
  requestComposerFocus,
  setMentionedAppId,
}: {
  appDispatch: Dispatch<AppAction>;
  expandProject: (projectId: string) => void;
  linkedProjectByAppId: Map<string, string>;
  requestComposerFocus: () => void;
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
        requestComposerFocus();
        return;
      }
      setMentionedAppId(null);
      appDispatch({ type: "beginNewChat", appId: app?.id ?? null });
      requestComposerFocus();
    },
    [appDispatch, expandProject, linkedProjectByAppId, requestComposerFocus, setMentionedAppId],
  );
}
