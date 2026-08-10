import type { Session } from "@openpond/contracts";
import { sessionTaskset } from "./session-tasksets";

export type SidebarTaskFilter =
  | "active"
  | "in_progress"
  | "pinned"
  | "saved_for_later"
  | "tasksets"
  | "done"
  | "all";

export type SidebarTaskSort = "recent" | "manual";

export type SidebarTasksetFilterOption = {
  id: string;
  name: string;
  chatCount: number;
};

export type SidebarTaskShortcutState = {
  count: number;
  label: "In Progress" | "Later";
  targetFilter: Extract<SidebarTaskFilter, "active" | "saved_for_later">;
  targetLabel: "active" | "saved for later";
};

export const SIDEBAR_TASK_FILTER_OPTIONS: ReadonlyArray<{
  value: SidebarTaskFilter;
  label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "in_progress", label: "In progress" },
  { value: "pinned", label: "Pinned" },
  { value: "saved_for_later", label: "Save for later" },
  { value: "tasksets", label: "Tasksets" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

export const SIDEBAR_TASK_SORT_OPTIONS: ReadonlyArray<{
  value: SidebarTaskSort;
  label: string;
}> = [
  { value: "recent", label: "Recent first" },
  { value: "manual", label: "Manual order" },
];

export function sidebarTaskRows(input: {
  activeSessions: readonly Session[];
  doneSessions: readonly Session[];
  filter: SidebarTaskFilter;
  inProgressSessionIds: ReadonlySet<string>;
  selectedTasksetId?: string | null;
  previewSessionIds?: readonly string[] | null;
  sort: SidebarTaskSort;
}): Session[] {
  const rows: Session[] = [];

  if (input.filter === "done") {
    rows.push(...input.doneSessions.filter((session) => !sessionTaskset(session)));
  } else if (input.filter === "all") {
    rows.push(
      ...input.activeSessions.filter((session) => !sessionTaskset(session)),
      ...input.doneSessions.filter((session) => !sessionTaskset(session))
    );
  } else if (input.filter === "tasksets") {
    rows.push(
      ...input.activeSessions.filter((session) =>
        matchesSelectedTaskset(session, input.selectedTasksetId)
      ),
      ...input.doneSessions.filter((session) =>
        matchesSelectedTaskset(session, input.selectedTasksetId)
      ),
    );
  } else {
    for (const session of input.activeSessions) {
      if (sessionTaskset(session)) continue;
      if (input.filter === "active") {
        if (!session.savedForLater) rows.push(session);
      } else if (input.filter === "in_progress") {
        if (
          !session.savedForLater &&
          input.inProgressSessionIds.has(session.id)
        ) {
          rows.push(session);
        }
      } else if (input.filter === "pinned") {
        if (session.pinned && !session.savedForLater) rows.push(session);
      } else if (input.filter === "saved_for_later") {
        if (session.savedForLater) rows.push(session);
      }
    }
  }

  const previewOrder = input.previewSessionIds
    ? new Map(
        input.previewSessionIds.map((sessionId, index) => [
          sessionId,
          index,
        ])
      )
    : null;

  if (input.sort === "recent") {
    return rows.sort((left, right) =>
      compareRecentSessions(left, right, previewOrder)
    );
  }

  return rows.sort((left, right) => {
    const leftPreview = previewOrder?.get(left.id);
    const rightPreview = previewOrder?.get(right.id);
    if (leftPreview !== undefined || rightPreview !== undefined) {
      if (leftPreview === undefined) return 1;
      if (rightPreview === undefined) return -1;
      if (leftPreview !== rightPreview) return leftPreview - rightPreview;
    }
    if (left.order !== right.order) return left.order - right.order;
    return compareRecentSessions(left, right);
  });
}

function matchesSelectedTaskset(
  session: Session,
  selectedTasksetId: string | null | undefined
): boolean {
  const taskset = sessionTaskset(session);
  return Boolean(
    taskset && (!selectedTasksetId || taskset.id === selectedTasksetId)
  );
}

export function sidebarTaskShortcutState(input: {
  activeCount: number;
  filter: SidebarTaskFilter;
  savedForLaterCount: number;
}): SidebarTaskShortcutState {
  if (input.filter === "saved_for_later" || input.filter === "tasksets") {
    return {
      count: Math.max(0, input.activeCount),
      label: "In Progress",
      targetFilter: "active",
      targetLabel: "active",
    };
  }
  return {
    count: Math.max(0, input.savedForLaterCount),
    label: "Later",
    targetFilter: "saved_for_later",
    targetLabel: "saved for later",
  };
}

export function sidebarTaskEmptyLabel(
  filter: SidebarTaskFilter,
  noun: "chats" | "tasks"
): string {
  switch (filter) {
    case "active":
      return `No active ${noun}`;
    case "in_progress":
      return "No work in progress";
    case "pinned":
      return `No pinned ${noun}`;
    case "saved_for_later":
      return "Nothing saved for later";
    case "tasksets":
      return "No Taskset chats yet";
    case "done":
      return `No done ${noun}`;
    case "all":
      return `No ${noun}`;
  }
}

export function mergeSidebarTaskOrder(
  allSessionIds: readonly string[],
  visibleSessionIds: readonly string[],
  orderedVisibleSessionIds: readonly string[]
): string[] {
  const visibleSessionIdSet = new Set(visibleSessionIds);
  let visibleIndex = 0;
  return allSessionIds.map((sessionId) => {
    if (!visibleSessionIdSet.has(sessionId)) return sessionId;
    const replacement = orderedVisibleSessionIds[visibleIndex];
    visibleIndex += 1;
    return replacement ?? sessionId;
  });
}

function compareRecentSessions(
  left: Session,
  right: Session,
  pinnedPreviewOrder: ReadonlyMap<string, number> | null = null
): number {
  const leftPinned = isSidebarTaskPinned(left);
  const rightPinned = isSidebarTaskPinned(right);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  if (leftPinned && rightPinned) {
    const leftPreview = pinnedPreviewOrder?.get(left.id);
    const rightPreview = pinnedPreviewOrder?.get(right.id);
    if (leftPreview !== undefined || rightPreview !== undefined) {
      if (leftPreview === undefined) return 1;
      if (rightPreview === undefined) return -1;
      if (leftPreview !== rightPreview) return leftPreview - rightPreview;
    }
    if (left.order !== right.order) return left.order - right.order;
  }

  const updatedDifference =
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedDifference !== 0) return updatedDifference;
  return left.title.localeCompare(right.title);
}

export function isSidebarTaskPinned(session: Session): boolean {
  return session.pinned && !session.savedForLater && !session.archived;
}
