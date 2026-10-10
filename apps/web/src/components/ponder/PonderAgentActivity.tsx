import type { PonderDesktopHandoffPresentation, Session } from "@openpond/contracts";
import { Bot } from "../icons";
import { ConversationSourceIcon } from "../sidebar/ConversationSourceIcon";
import type { PonderLinkedLocalWork } from "./ponder-local-work";

function taskStatus(item: PonderLinkedLocalWork): string {
  const outcome = item.deliveries[0]?.outcome;
  if (outcome === "completed") return "Completed";
  if (outcome === "failed") return "Failed";
  if (outcome === "cancelled") return "Stopped";
  switch (item.status) {
    case "ready": return "Waiting to start on desktop";
    case "dispatching": return "Starting on desktop";
    case "admitted": return "Waiting for result";
    case "completed": return "Completed";
    case "failed": return "Failed to start";
    case "cancelled": return "Stopped";
    case "expired": return "Couldn’t start before the request expired";
    case "attention": return "Needs attention";
    default: return "Checking task status";
  }
}

/** Only canonical task receipts can announce creation or provide a task link. */
export function PonderAgentActivity({ items, workflow, sessions, onOpenTask }: {
  items: readonly PonderLinkedLocalWork[];
  workflow?: PonderDesktopHandoffPresentation;
  sessions: readonly Session[];
  onOpenTask: (item: PonderLinkedLocalWork) => void;
}) {
  const memberIds = workflow ? new Set([
    workflow.prerequisite.sessionId, workflow.successor.sessionId, workflow.workflow?.preparationSessionId,
  ]) : null;
  const tasks = [...new Map([...items].reverse()
    .filter(item => item.sessionId && (!memberIds || memberIds.has(item.sessionId)))
    .map(item => [item.sessionId!, item])).values()].reverse();
  if (!tasks.length) return null;
  const byId = new Map(sessions.map(session => [session.id, session]));
  return <div className="assistant-sources ponder-agent-sources" aria-label="Conversations started">
    <h3>Conversations started</h3>
    <div className="assistant-source-stack">
      {tasks.map(item => {
        const session = byId.get(item.sessionId!);
        return <button key={item.sessionId} type="button" className="assistant-source-pill"
          title={`${item.title} · ${taskStatus(item)}`} aria-label={`Open ${item.title}`}
          onClick={() => onOpenTask(item)}>
          {session ? <ConversationSourceIcon session={session} /> : <Bot size={14} aria-hidden="true" />}
          <span>{item.title}</span>
        </button>;
      })}
    </div>
  </div>;
}
