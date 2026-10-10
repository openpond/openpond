import type { PonderDesktopHandoffPresentation, Session } from "@openpond/contracts";
import { sidebarInboxTime } from "./sidebar-inbox";
import { isSidebarTaskPinned } from "./sidebar-task-list";

export type SidebarWorkflowRow = {
  group: PonderDesktopHandoffPresentation;
  members: Session[];
  sessions: Session[];
  pinned: boolean;
  archived: boolean;
};

/** Actions use the entire workflow, even when a list filter hides some members. */
export function sidebarWorkflowRows(
  groups: readonly PonderDesktopHandoffPresentation[],
  sessions: readonly Session[],
  visibleSessions: readonly Session[],
): SidebarWorkflowRow[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const visibleIds = new Set(visibleSessions.map(session => session.id));
  return groups.flatMap(group => {
    const ids = new Set([group.prerequisite.sessionId, group.successor.sessionId, group.workflow?.preparationSessionId]);
    const members = [...ids].flatMap(id => id && byId.has(id) ? [byId.get(id)!] : []);
    const active = members.filter(session => !session.archived && !session.hiddenFromDefaultSidebar);
    const pinned = active.length > 0 && active.every(isSidebarTaskPinned);
    const children = members.filter(session => visibleIds.has(session.id) && (pinned || !isSidebarTaskPinned(session)));
    return children.length ? [{ group, members, sessions: children, pinned, archived: members.every(session => session.archived) }] : [];
  });
}

export type SidebarInboxEntry =
  | { kind: "session"; id: string; session: Session; time: number; running: boolean }
  | { kind: "workflow"; id: string; workflow: SidebarWorkflowRow; time: number; running: boolean };

/** A workflow occupies one inbox position, using its latest meaningful member activity. */
export function sidebarWorkflowInbox(
  sessions: readonly Session[],
  workflows: readonly SidebarWorkflowRow[],
  workflowSessionIds: ReadonlySet<string>,
  activity: Readonly<Record<string, string>>,
  runningIds: ReadonlySet<string>,
): SidebarInboxEntry[] {
  const entries: SidebarInboxEntry[] = [...new Map(sessions.map(session => [session.id, session])).values()]
    .filter(session => !workflowSessionIds.has(session.id) && !isSidebarTaskPinned(session))
    .map(session => ({ kind: "session", id: `session:${session.id}`, session, time: sidebarInboxTime(session, activity), running: runningIds.has(session.id) }));
  for (const workflow of workflows) {
    if (workflow.pinned) continue;
    entries.push({ kind: "workflow", id: `workflow:${workflow.group.id}`, workflow,
      time: Math.max(...workflow.members.map(session => sidebarInboxTime(session, activity))),
      running: workflow.members.some(session => runningIds.has(session.id)),
    });
  }
  return entries.sort((left, right) => Number(right.running) - Number(left.running) || right.time - left.time || left.id.localeCompare(right.id));
}
