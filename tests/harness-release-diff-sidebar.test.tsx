import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { HarnessReleaseDiffSidebar } from "../apps/web/src/components/settings/HarnessReleaseDiffSidebar";

describe("HarnessReleaseDiffSidebar", () => {
  test("labels the immutable release comparison controls", () => {
    const markup = renderToStaticMarkup(
      createElement(HarnessReleaseDiffSidebar, {
        connection: {
          serverUrl: "http://127.0.0.1:4310",
          token: "test-token",
          platform: "darwin",
        },
        expanded: false,
        onResizeStart: () => undefined,
        onToggleExpanded: () => undefined,
        selection: {
          workspaceId: "personal-default",
          baseRelease: { id: "before", contentHash: "1111111111111111" },
          targetRelease: { id: "after", contentHash: "2222222222222222" },
          title: "Prefer the bundled document runtime",
        },
      }),
    );

    expect(markup).toContain('aria-label="Workspace diffs"');
    expect(markup).toContain('aria-label="Resize diff panel"');
    expect(markup).toContain('aria-label="Right sidebar views"');
    expect(markup).toContain("Loading workspace files");
  });
});
