import type { Session } from "@openpond/contracts";
import type { usePonderLocalMessage } from "./usePonderLocalMessage";

export function PonderLocalMessageControl({ sessions, state, onSelect }: {
  sessions: Session[]; state: ReturnType<typeof usePonderLocalMessage>; onSelect(id: string | null): void;
}) {
  const targets = sessions.filter(session => !session.archived && ["codex", "claude-code", "opencode", "grok-build"].includes(session.provider)
    && !["sandbox", "sandbox_app", "sandbox_template"].includes(session.workspaceKind ?? ""));
  if (!targets.length && !state.sessionId) return null;
  return <div className="ponder-local-message-control">
    <label>Send a local task message<select aria-label="Ponder local message target" value={state.sessionId ?? ""}
      onChange={event => onSelect(event.target.value || null)}><option value="">Chat with Ponder</option>
      {state.sessionId && !targets.some(session => session.id === state.sessionId) ? <option value={state.sessionId}>{state.target?.title ?? "Selected task unavailable"}</option> : null}
      {targets.map(session => <option key={session.id} value={session.id}>{session.title} · {session.provider === "claude-code" ? "Claude Code" : session.provider === "opencode" ? "OpenCode" : session.provider === "grok-build" ? "Grok Build" : "Codex"}</option>)}
    </select></label>
    {state.target ? <>
      <select aria-label="Local message delivery" value={state.mode} onChange={event => state.setMode(event.target.value as "followup" | "steer")}>
        <option value="followup">Queue a follow-up</option><option value="steer" disabled={!state.target.canSteer}>Correct the active Codex turn</option>
      </select>
      {state.target.unavailableReason ? <small>{state.target.unavailableReason}</small> : null}
      {state.target.paused ? <small>Paused — messages stay queued until you resume the task.</small> : state.target.approvalBlocked ? <small>Waiting for permission — sending a message does not approve it.</small> : null}
      {state.changed ? <><small>The task changed. Refresh and review its current state before sending.</small><button type="button" onClick={() => void state.refresh()}>Refresh target</button></> : null}
    </> : state.sessionId ? <small>Inspecting the original managed session…</small> : null}
    {state.receipt ? <small role="status">{state.receipt.state === "resolved" ? state.receipt.error ? "Agent request failed" : "Agent request acknowledged" : state.receipt.state === "pending" ? "Message queued" : `Message ${state.receipt.state}`}{state.receipt.error ? `: ${state.receipt.error}` : ""}</small> : null}
    {state.error ? <small role="alert">{state.error}</small> : null}
  </div>;
}
