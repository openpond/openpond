import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@openpond/contracts";
import { groupSidebarTaskRows } from "../apps/web/src/components/sidebar/SidebarSectionList";
import { SidebarTaskProjectGroup } from "../apps/web/src/components/sidebar/SidebarTaskProjectGroup";

describe("sidebar task project grouping", () => {
  test("keeps group and task order stable", () => {
    const sessions = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ] as Session[];
    const projectBySession = { a: "alpha", b: "beta", c: "alpha" };

    expect(
      groupSidebarTaskRows(sessions, (session) => {
        const project = projectBySession[session.id as keyof typeof projectBySession];
        return {
          key: project,
          label: project.toUpperCase(),
          projectId: project,
          kind: "project" as const,
        };
      }).map((group) => ({
        key: group.key,
        projectId: group.projectId,
        kind: group.kind,
        sessions: group.sessions.map((session) => session.id),
      })),
    ).toEqual([
      { key: "alpha", projectId: "alpha", kind: "project", sessions: ["a", "c"] },
      { key: "beta", projectId: "beta", kind: "project", sessions: ["b"] },
    ]);
  });

  test("renders the whole project header as an accessible disclosure", () => {
    const expanded = renderToStaticMarkup(
      createElement(
        SidebarTaskProjectGroup,
        {
          count: 2,
          expanded: true,
          groupKey: "project:openpond",
          kind: "project",
          label: "OpenPond",
          onToggle: () => undefined,
        },
        createElement("div", null, "Task row"),
      ),
    );

    expect(expanded).toContain('class="sidebar-task-project-group-header"');
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('aria-controls="sidebar-task-group-project-openpond"');
    expect(expanded).toContain("folder-open");
    expect(expanded).toContain("Task row");

    const collapsed = renderToStaticMarkup(
      createElement(
        SidebarTaskProjectGroup,
        {
          count: 2,
          expanded: false,
          groupKey: "project:openpond",
          kind: "project",
          label: "OpenPond",
          onToggle: () => undefined,
        },
        createElement("div", null, "Task row"),
      ),
    );
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain("Task row");
  });
});
