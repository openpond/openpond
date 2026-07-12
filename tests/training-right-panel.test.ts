import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RightSidebarHomePanel } from "../apps/web/src/components/app-shell/RightSidebarHomePanel";
import { TrainingDraftPanel } from "../apps/web/src/components/training/TrainingDraftPanel";
import { sourceFixture } from "./helpers/training-fixtures";

describe("Training right panel", () => {
  test("registers one compact Task draft action in the existing controller", () => {
    const html = renderToStaticMarkup(createElement(RightSidebarHomePanel, { expanded: false, terminalOpen: false, sideChatAvailable: true, trainingDraftAvailable: true, onOpenBrowser: () => undefined, onOpenFiles: () => undefined, onOpenReview: () => undefined, onOpenSideChat: () => undefined, onOpenTrainingDraft: () => undefined, onResizeStart: () => undefined, onToggleExpanded: () => undefined, onToggleTerminal: () => undefined }));
    expect(html).toContain("Task draft");
    expect(html).toContain("right-sidebar-home-panel");
  });

  test("keeps the companion panel compact and links to full Training", () => {
    const source = sourceFixture();
    const training = { payload: { sources: [source], creations: [] } } as any;
    const html = renderToStaticMarkup(createElement(TrainingDraftPanel, { training, sessionId: source.sessionId, expanded: false, onOpenTraining: () => undefined, onResizeStart: () => undefined, onToggleExpanded: () => undefined }));
    expect(html).toContain(source.title);
    expect(html).toContain("Open Training");
    expect(html).not.toContain("Grader Lab");
  });
});
