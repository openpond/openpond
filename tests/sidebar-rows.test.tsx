import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { LocalProject, Session } from "@openpond/contracts";
import {
  SidebarProjectRow,
  SidebarSessionRow,
} from "../apps/web/src/components/sidebar/SidebarRows";

describe("sidebar row updated dates", () => {
  test("renders a chat's last updated date beside its title", () => {
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

    expect(markup).toContain(">Aug 9</time>");
    expect(markup).not.toContain("Updated");
    expect(markup).not.toContain("Aug 9, 2026</time>");
    expect(markup).toContain('dateTime="2026-08-09T12:30:00.000Z"');
    expect(markup).toContain("OpenPond");
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

    expect(markup).toContain(">Aug 8</time>");
    expect(markup).not.toContain("Updated");
    expect(markup).not.toContain("Aug 8, 2026</time>");
    expect(markup).toContain('dateTime="2026-08-08T12:30:00.000Z"');
  });
});

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
