import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";

import {
  composerPlaceholder,
  composerTaskDraftShortcut,
} from "../apps/web/src/components/chat/composer-task-draft";
import { SidebarSessionRow } from "../apps/web/src/components/sidebar/SidebarRows";
import {
  isTaskDraftSession,
  taskDraftPrompt,
  taskDraftTitle,
  withTaskDraftMetadata,
  withoutTaskDraftMetadata,
} from "../apps/web/src/lib/task-drafts";

describe("task drafts", () => {
  test("stores and removes persisted task draft metadata", () => {
    const metadata = withTaskDraftMetadata(
      { workspaceTarget: "local" },
      "Prepare the release notes",
      "2026-08-09T20:00:00.000Z"
    );
    const session = sessionFixture({ metadata });

    expect(isTaskDraftSession(session)).toBe(true);
    expect(taskDraftPrompt(session)).toBe("Prepare the release notes");
    expect(withoutTaskDraftMetadata(metadata)).toEqual({
      workspaceTarget: "local",
    });
  });

  test("uses the first instruction line as a bounded sidebar title", () => {
    expect(taskDraftTitle("\n  Review the API contract\nThen update tests"))
      .toBe("Review the API contract");
    expect(taskDraftTitle("x".repeat(100))).toHaveLength(64);
  });

  test("uses Ctrl/Cmd+Enter for Work drafts", () => {
    expect(
      composerTaskDraftShortcut("Enter", true, false, false, "work", "chat", true)
    ).toBe(true);
    expect(
      composerTaskDraftShortcut("Enter", false, true, false, "work", "chat", true)
    ).toBe(true);
    expect(
      composerTaskDraftShortcut("Enter", false, false, false, "work", "chat", true)
    ).toBe(false);
    expect(
      composerTaskDraftShortcut("Enter", true, false, false, "chat", "chat", true)
    ).toBe(false);
    expect(
      composerTaskDraftShortcut("Enter", true, false, true, "work", "chat", true)
    ).toBe(false);
  });

  test("adds the draft shortcut to the Work start placeholder", () => {
    expect(
      composerPlaceholder({ experience: "work", mode: "start", surface: "chat" })
    ).toBe("What should we work on? Ctrl Enter to save as draft");
  });

  test("renders a saved draft in yellow with Draft on its second row", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarSessionRow, {
        session: sessionFixture({
          metadata: withTaskDraftMetadata(
            {},
            "Prepare the release notes",
            "2026-08-09T20:00:00.000Z"
          ),
        }),
        selected: false,
        projectLabel: "Draft",
        onSelect: () => undefined,
        onTogglePin: () => undefined,
        onArchive: () => undefined,
      })
    );

    expect(markup).toContain("sidebar-task-row is-draft");
    expect(markup).toContain('class="sidebar-session-project-label">Draft</span>');
  });
});

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: "draft_session",
    experience: "work",
    provider: "openpond",
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    openPondCommandAccessMode: "ask",
    title: "Prepare the release notes",
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-08-09T20:00:00.000Z",
    updatedAt: "2026-08-09T20:00:00.000Z",
    status: "idle",
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
