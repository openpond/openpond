import { useState, type ReactNode } from "react";
import type { Session } from "@openpond/contracts";
import type { SidebarWorkflowRow } from "../../lib/sidebar-workflow-list";
import { clientChoiceStorage, useHydratedClientChoice } from "../../lib/client-choice-storage";
import { SidebarTaskProjectGroup } from "./SidebarTaskProjectGroup";
import { Check, Pin, RotateCcw } from "../icons";

/** Display membership only; native subagent ancestry and session identity remain authoritative. */
export function SidebarWorkflowGroups({
  groups,
  renderSession,
  toggleSessionPinned,
  archiveSession,
  restoreSession,
}: {
  groups: SidebarWorkflowRow[];
  renderSession(session: Session): ReactNode;
  toggleSessionPinned(session: Session, pinned?: boolean): void;
  archiveSession(session: Session): void;
  restoreSession(session: Session): void;
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
  return groups.map(({ group, members, sessions: children, pinned, archived }) => {
    const expanded = !collapsed.has(group.id);
    const togglePin = () => {
      for (const session of members) {
        if (session.pinned === pinned || (!pinned && (session.savedForLater || session.archived))) {
          toggleSessionPinned(session, !pinned);
        }
      }
    };
    const toggleDone = () => {
      for (const session of members) {
        if (archived) restoreSession(session);
        else if (!session.archived) archiveSession(session);
      }
    };
    return (
      <div key={group.id} className={`sidebar-workflow-group${pinned ? " is-pinned" : ""}`}>
        <SidebarTaskProjectGroup
          groupKey={group.id}
          kind="projectless"
          label={group.title}
          expanded={expanded}
          actions={<>
            <button type="button" className="sidebar-thread-pin sidebar-workflow-pin"
              aria-label={`${pinned ? "Unpin" : "Pin"} group: ${group.title}`}
              aria-pressed={pinned} title={pinned ? "Unpin group" : "Pin group"} onClick={togglePin}>
              <Pin size={16} aria-hidden="true" />
            </button>
            <button type="button" className="sidebar-inbox-done"
              aria-label={`${archived ? "Reopen" : "Mark done"} group: ${group.title}`}
              title={archived ? "Reopen group" : "Mark group done (does not stop running work)"} onClick={toggleDone}>
              {archived ? <RotateCcw size={19} /> : <Check size={21} />}
            </button>
          </>}
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
