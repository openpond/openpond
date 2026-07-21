import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const FOCUSED_MODULES = [
  "apps/web/src/components/app-shell/RightChatPanelStack.tsx",
  "apps/web/src/components/app-shell/RightChatPane.tsx",
  "apps/web/src/components/app-shell/right-chat-panel-types.ts",
  "apps/web/src/components/create-improve/create-improve-authoring-cancellation.ts",
  "apps/web/src/components/create-improve/create-improve-authoring-model.ts",
  "apps/web/src/hooks/useLabAgentAuthoring.ts",
  "apps/web/src/hooks/useRightChatHistorySubscriptions.ts",
  "apps/web/src/hooks/useRightChatPanels.ts",
  "apps/web/src/hooks/useRightChatPanelViews.ts",
  "apps/web/src/lib/right-chat-command-policy.ts",
] as const;

describe("Agent flow source structure", () => {
  test("keeps extracted responsibilities in focused modules under 500 lines", async () => {
    const sources = await Promise.all(FOCUSED_MODULES.map((path) => readFile(path, "utf8")));
    for (const [index, source] of sources.entries()) {
      expect(
        source.split(/\r?\n/).length,
        `${FOCUSED_MODULES[index]} should stay below 500 lines`,
      ).toBeLessThan(500);
    }
  });

  test("keeps orchestration owners wired to the extracted boundaries", async () => {
    const [dialog, mainPane, rightChat] = await Promise.all([
      readFile("apps/web/src/components/create-improve/CreateImproveAuthoringDialog.tsx", "utf8"),
      readFile("apps/web/src/components/app-shell/MainPane.tsx", "utf8"),
      readFile("apps/web/src/hooks/useRightChatPanels.ts", "utf8"),
    ]);

    expect(dialog).toContain('from "./create-improve-authoring-model"');
    expect(dialog).toContain('from "./create-improve-authoring-cancellation"');
    expect(mainPane).toContain("useLabAgentAuthoring");
    expect(rightChat).toContain("useRightChatPanelViews");
    expect(rightChat).toContain("useRightChatHistorySubscriptions");
    expect(rightChat).toContain("rightChatCommandPolicy");
  });
});
