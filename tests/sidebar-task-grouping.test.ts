import { describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";
import { groupSidebarTaskRows } from "../apps/web/src/components/sidebar/SidebarSectionList";

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
        return { key: project, label: project.toUpperCase() };
      }).map((group) => ({
        key: group.key,
        sessions: group.sessions.map((session) => session.id),
      })),
    ).toEqual([
      { key: "alpha", sessions: ["a", "c"] },
      { key: "beta", sessions: ["b"] },
    ]);
  });
});
