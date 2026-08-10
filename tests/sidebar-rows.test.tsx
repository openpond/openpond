import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { LocalProject, Session } from "@openpond/contracts";
import {
  SidebarProjectRow,
  SidebarSessionRow,
} from "../apps/web/src/components/sidebar/SidebarRows";

describe("sidebar row updated dates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T20:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  test("shows only the time for a task updated today", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarSessionRow, {
        session: sessionFixture(),
        selected: false,
        projectLabel: "OpenPond",
        onSelect: () => undefined,
        onTogglePin: () => undefined,
        onArchive: () => undefined,
      })
    );

    expect(markup).toContain(`>${formattedTime(sessionFixture().updatedAt)}</time>`);
    expect(markup).not.toContain(">Aug 9 ");
    expect(markup).not.toContain("Updated");
    expect(markup).not.toContain("Aug 9, 2026</time>");
    expect(markup).toContain('dateTime="2026-08-09T12:30:00.000Z"');
    expect(markup).toContain(
      '<span class="sidebar-session-detail-line"><span class="sidebar-session-project-label">OpenPond</span><div class="sidebar-row-actions sidebar-task-inline-actions">',
    );
    expect(markup.indexOf("sidebar-task-inline-actions")).toBeLessThan(
      markup.indexOf("sidebar-row-updated-at"),
    );
  });

  test("renders a project's last updated date beside its name", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarProjectRow, {
        project: projectFixture(),
        selected: false,
        onSelect: () => undefined,
        onNewChat: () => undefined,
        onTogglePin: () => undefined,
        onRemove: () => undefined,
      })
    );

    expect(markup).toContain(
      `>Aug 8 ${formattedTime(projectFixture().updatedAt)}</time>`,
    );
    expect(markup).not.toContain("Updated");
    expect(markup).not.toContain("Aug 8, 2026</time>");
    expect(markup).toContain('dateTime="2026-08-08T12:30:00.000Z"');
  });
});

function formattedTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function sessionFixture(): Session {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: null,
    title: "Add sidebar dates",
    appId: null,
    appName: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-08-01T12:30:00.000Z",
    updatedAt: "2026-08-09T12:30:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}

function projectFixture(): LocalProject {
  return {
    id: "project_1",
    name: "OpenPond",
    path: "/workspace/openpond",
    workspacePath: "/workspace/openpond",
    repoPath: "/workspace/openpond",
    source: "git",
    createdAt: "2026-08-01T12:30:00.000Z",
    updatedAt: "2026-08-08T12:30:00.000Z",
  };
}
