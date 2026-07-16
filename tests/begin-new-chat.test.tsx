import { describe, expect, test } from "vitest";
import type { OpenPondApp } from "@openpond/contracts";
import { createElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AppAction } from "../apps/web/src/app/app-state";
import { useBeginNewChat } from "../apps/web/src/hooks/useBeginNewChat";
import { projectSelectionKey } from "../apps/web/src/lib/app-models";

type BeginNewChat = (app?: OpenPondApp | null) => void;

function renderBeginNewChatHook(linkedProjectByAppId = new Map<string, string>()) {
  const appActions: AppAction[] = [];
  const expandedProjects: string[] = [];
  const mentionedAppIds: (string | null)[] = [];
  let focusRequestCount = 0;
  let beginNewChat: BeginNewChat | null = null;

  const appDispatch: Dispatch<AppAction> = (action) => {
    appActions.push(action);
  };
  const setMentionedAppId: Dispatch<SetStateAction<string | null>> = (value) => {
    mentionedAppIds.push(typeof value === "function" ? value(null) : value);
  };

  function Harness() {
    beginNewChat = useBeginNewChat({
      appDispatch,
      expandProject: (projectId) => expandedProjects.push(projectId),
      linkedProjectByAppId,
      requestComposerFocus: () => {
        focusRequestCount += 1;
      },
      setMentionedAppId,
    });
    return null;
  }

  renderToStaticMarkup(createElement(Harness));

  if (!beginNewChat) throw new Error("useBeginNewChat did not initialize");
  return {
    appActions,
    beginNewChat,
    expandedProjects,
    get focusRequestCount() {
      return focusRequestCount;
    },
    mentionedAppIds,
  };
}

describe("useBeginNewChat", () => {
  test("requests composer focus when starting a fresh chat", () => {
    const harness = renderBeginNewChatHook();

    harness.beginNewChat(null);

    expect(harness.appActions).toEqual([{ type: "beginNewChat", appId: null }]);
    expect(harness.expandedProjects).toEqual([]);
    expect(harness.mentionedAppIds).toEqual([null]);
    expect(harness.focusRequestCount).toBe(1);
  });

  test("requests composer focus when routing an app chat to a linked project", () => {
    const app = { id: "app_1", name: "App 1" } as OpenPondApp;
    const projectId = projectSelectionKey("local", "project_1");
    const harness = renderBeginNewChatHook(new Map([[app.id, "project_1"]]));

    harness.beginNewChat(app);

    expect(harness.appActions).toEqual([{ type: "selectProject", projectId }]);
    expect(harness.expandedProjects).toEqual([projectId]);
    expect(harness.mentionedAppIds).toEqual([null]);
    expect(harness.focusRequestCount).toBe(1);
  });
});
