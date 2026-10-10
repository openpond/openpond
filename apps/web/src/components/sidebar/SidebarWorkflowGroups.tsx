import { useState, type ReactNode } from "react";
import type { PonderDesktopHandoffPresentation, Session } from "@openpond/contracts";
import { clientChoiceStorage, useHydratedClientChoice } from "../../lib/client-choice-storage";
import { SidebarTaskProjectGroup } from "./SidebarTaskProjectGroup";

/** Display membership only; native subagent ancestry and session identity remain authoritative. */
export function SidebarWorkflowGroups({
  groups,
  sessions,
  renderSession,
}: {
  groups: PonderDesktopHandoffPresentation[];
  sessions: Session[];
  renderSession(session: Session): ReactNode;
}) {
  const readCollapsed = () => {
    try {
      return new Set<string>(
        JSON.parse(clientChoiceStorage.getItem("openpond.sidebar.workflow-collapse.v1") ?? "[]"),
      );
    } catch {
      return new Set<string>();
    }
  };
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useHydratedClientChoice(() => setCollapsed(readCollapsed()));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return groups.map((group) => {
    const ids = [
      ...new Set(
        [group.prerequisite.sessionId, group.successor.sessionId, group.workflow?.preparationSessionId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ];
    const children = ids
      .map((id) => byId.get(id))
      .filter((session): session is Session => Boolean(session && !session.pinned));
    if (!children.length) return null;
    const expanded = !collapsed.has(group.id);
    return (
      <div key={group.id} className="sidebar-workflow-group">
        <SidebarTaskProjectGroup
          groupKey={group.id}
          kind="projectless"
          label={group.title}
          expanded={expanded}
          onToggle={() => {
            const next = new Set(collapsed);
            if (expanded) next.add(group.id);
            else next.delete(group.id);
            setCollapsed(next);
            clientChoiceStorage.setItem(
              "openpond.sidebar.workflow-collapse.v1",
              JSON.stringify([...next].slice(-200)),
            );
          }}
        >
          {children.map((session) => renderSession(session))}
        </SidebarTaskProjectGroup>
      </div>
    );
  });
}
