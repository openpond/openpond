import { describe, expect, test } from "vitest";
import type { SidebarFileBookmark } from "@openpond/contracts";
import {
  clearHandledSidebarFileOpenRequest,
  sidebarFileOpenRequestMatchesConversation,
  type SidebarFileOpenRequest,
} from "../apps/web/src/lib/sidebar-files";

const file: SidebarFileBookmark = {
  id: "sidebar-file:local:project-a:README.md",
  scope: "workspace",
  status: "pinned",
  workspaceKind: "local",
  workspaceId: "project-a",
  path: "README.md",
  available: true,
  order: 0,
  sourceSessionId: null,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

function request(id: number, conversationId: string): SidebarFileOpenRequest {
  return { id, conversationId, file };
}

describe("sidebar file open requests", () => {
  test("cannot replay a pinned file request in another conversation", () => {
    const pending = request(1, "task-a");

    expect(sidebarFileOpenRequestMatchesConversation(pending, "task-a")).toBe(true);
    expect(sidebarFileOpenRequestMatchesConversation(pending, "task-b")).toBe(false);
  });

  test("handling an older request does not clear a newer file selection", () => {
    const newer = request(2, "task-a");

    expect(clearHandledSidebarFileOpenRequest(newer, 1)).toBe(newer);
    expect(clearHandledSidebarFileOpenRequest(newer, 2)).toBeNull();
  });
});
