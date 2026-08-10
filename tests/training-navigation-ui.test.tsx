import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { RightSidebarHomePanel } from "../apps/web/src/components/app-shell/RightSidebarHomePanel";
import { SidebarNavigation } from "../apps/web/src/components/sidebar/SidebarNavigation";
import { TrainingDraftPanel } from "../apps/web/src/components/training/TrainingDraftPanel";
import { sourceFixture } from "./helpers/training-fixtures";

describe("training navigation surfaces", () => {
  test("keeps training inside the active Models destination", () => {
    const html = renderToStaticMarkup(createElement(SidebarNavigation, {
      beginNewChat: () => undefined,
      productArea: "models",
      setSectionMenuOpen: () => undefined,
      setSelectedAppId: () => undefined,
      setSelectedProjectId: () => undefined,
      setSelectedSessionId: () => undefined,
      setView: () => undefined,
      view: "labs",
    }));
    expect(html).toContain("Models");
    expect(html).toContain("Tasksets");
    expect(html).toContain("Serving");
    expect(html).toContain("Usage");
    expect(html).toContain('class="nav-command active" aria-label="Models"');
    expect(html).not.toContain("training-navigation-rail");
  });

  test("offers the compact Task draft entry and full Training handoff", () => {
    const home = renderToStaticMarkup(createElement(RightSidebarHomePanel, {
      expanded: false,
      terminalOpen: false,
      sideChatAvailable: true,
      trainingDraftAvailable: true,
      onOpenBrowser: () => undefined,
      onOpenFiles: () => undefined,
      onOpenReview: () => undefined,
      onOpenSideChat: () => undefined,
      onOpenTrainingDraft: () => undefined,
      onResizeStart: () => undefined,
      onToggleExpanded: () => undefined,
      onToggleTerminal: () => undefined,
    }));
    const source = sourceFixture();
    const panel = renderToStaticMarkup(createElement(TrainingDraftPanel, {
      training: { payload: { sources: [source], creations: [] } } as any,
      sessionId: source.sessionId,
      expanded: false,
      onOpenTraining: () => undefined,
      onResizeStart: () => undefined,
      onToggleExpanded: () => undefined,
    }));
    expect(home).toContain("Task draft");
    expect(home).toContain("right-sidebar-home-panel");
    expect(panel).toContain(source.title);
    expect(panel).toContain("Open Training");
  });
});
