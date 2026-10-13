import { useMemo, type ReactNode } from "react";
import type { Session } from "@openpond/contracts";
import { sidebarInboxEntryDateGroups } from "../../lib/sidebar-inbox";
import type { SidebarInboxEntry, SidebarWorkflowRow } from "../../lib/sidebar-workflow-list";
import { SIDEBAR_TASK_INITIAL_LIMIT } from "../../lib/app-models";
import {
  nextSidebarChatVisibleCount,
  previousSidebarChatVisibleCount,
} from "../../lib/sidebar-pagination";
import { SidebarShowMoreButton } from "./SidebarRows";

export function SidebarInbox({
  rows,
  count,
  setCount,
  selectedSessionId,
  emptyLabel,
  renderSession,
  renderWorkflow,
}: {
  rows: SidebarInboxEntry[];
  count: number;
  setCount: (next: number) => void;
  selectedSessionId: string | null;
  emptyLabel: string | null;
  renderSession: (session: Session) => ReactNode;
  renderWorkflow: (workflow: SidebarWorkflowRow) => ReactNode;
}) {
  // Keep a selected conversation reachable even when it is outside this page.
  const visible = useMemo(
    () =>
      rows.filter(
        (entry, index) =>
          index < Math.max(SIDEBAR_TASK_INITIAL_LIMIT, count) ||
          (entry.kind === "session"
            ? entry.session.id === selectedSessionId
            : entry.workflow.members.some((session) => session.id === selectedSessionId)),
      ),
    [rows, count, selectedSessionId],
  );
  const groups = useMemo(() => sidebarInboxEntryDateGroups(visible, (entry) => entry), [visible]);
  return (
    <section className="sidebar-thread-inbox" aria-label="Thread inbox">
      {groups.map((group) => (
        <div key={group.key}>
          {group.label ? <h3 className="sidebar-inbox-date">{group.label}</h3> : null}
          {group.entries.map((entry) => (
            <div key={entry.id}>
              {entry.kind === "workflow"
                ? renderWorkflow(entry.workflow)
                : renderSession(entry.session)}
            </div>
          ))}
        </div>
      ))}
      {rows.length === 0 && emptyLabel ? <div className="empty-row">{emptyLabel}</div> : null}
      {rows.length > SIDEBAR_TASK_INITIAL_LIMIT ? (
        <div
          className="sidebar-pagination-controls"
          aria-label={`Showing ${visible.length} of ${rows.length} threads`}
        >
          {count < rows.length ? (
            <SidebarShowMoreButton
              onClick={() => setCount(nextSidebarChatVisibleCount(count, rows.length))}
            >
              Show more
            </SidebarShowMoreButton>
          ) : null}
          {count > SIDEBAR_TASK_INITIAL_LIMIT ? (
            <SidebarShowMoreButton
              onClick={() => setCount(previousSidebarChatVisibleCount(count, rows.length))}
            >
              Show less
            </SidebarShowMoreButton>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
