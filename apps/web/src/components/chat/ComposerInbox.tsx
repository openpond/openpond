import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import type { RuntimeEvent } from "@openpond/contracts";
import type { TaskInboxController } from "../../hooks/useTaskInbox";
import { composerInboxEntries, inboxDeliveryLabel } from "../../lib/composer-inbox";
import { Inbox, RefreshCw, X } from "../icons";
import "../../styles/training/training.css";
import "../../styles/labs/evaluation-workspace.css";
import "./composer-inbox.css";

/** Inspecting messages never changes delivery or starts work. */
export function ComposerInbox({ inbox, sessionId, events }: {
  inbox: TaskInboxController;
  sessionId: string;
  events: readonly RuntimeEvent[];
}) {
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const entries = useMemo(() => composerInboxEntries(sessionId, inbox.snapshot, events), [sessionId, inbox.snapshot, events]);
  const pending = entries.filter(entry => entry.direction === "received" && entry.input.state === "pending");
  const rows = entries.slice(0, 50);
  useEffect(() => {
    if (!open) return;
    function position() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(280, window.innerWidth - 24);
      const above = rect.top - 20;
      const below = window.innerHeight - rect.bottom - 20;
      const upward = above >= below;
      setStyle({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: upward ? "auto" : rect.bottom + 8, bottom: upward ? window.innerHeight - rect.top + 8 : "auto",
        maxHeight: Math.max(120, Math.min(480, upward ? above : below)) });
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="composer-inbox-trigger" popoverTarget={panelId}
      aria-label={`Chat inbox, ${pending.length} pending ${pending.length === 1 ? "message" : "messages"}`} aria-haspopup="dialog" aria-expanded={open}
      data-tooltip="Chat inbox" onClick={() => { if (!open) void inbox.refresh(); }}>
      <Inbox size={16} />{pending.length > 0 ? <span className="composer-inbox-count">{pending.length}</span> : null}
    </button>
    <div ref={panel} id={panelId} popover="auto" role="dialog" aria-labelledby={`${panelId}-title`}
      className="composer-inbox-popover" style={style} onToggle={event => setOpen(event.newState === "open")}>
      <header>
        <h2 id={`${panelId}-title`}>Chat inbox</h2>
        <button type="button" aria-label="Refresh inbox" data-tooltip="Refresh inbox" onClick={() => void inbox.refresh()}><RefreshCw size={15} /></button>
        <button type="button" aria-label="Close inbox" onClick={() => { panel.current?.hidePopover(); trigger.current?.focus(); }}><X size={15} /></button>
      </header>
      <div className="composer-inbox-scroll">
        {rows.length ? <table className="training-data-table evaluation-workspace-table">
          <thead><tr><th scope="col">Route</th><th scope="col">Message</th></tr></thead>
          <tbody>{rows.map(({input, direction, peer}) => <tr key={input.id}>
            <td><span className="composer-inbox-sender">{direction === "sent" ? `This chat → ${peer}` : `${peer} → This chat`}</span>
              <time dateTime={input.createdAt}>{new Date(input.createdAt).toLocaleString()}</time>
              <span className="composer-inbox-status">{inboxDeliveryLabel(input)}</span></td>
            <td><span className="composer-inbox-kind">{input.kind === "steer" ? "Steering" : input.kind === "queued" ? "Queued assignment" : input.kind === "followup" ? "Follow-up" : input.kind === "result" ? "Result" : "Message"}</span>
              <details><summary>{input.body}</summary><div className="composer-inbox-body">{input.body}</div>
                {input.replyTo ? <small>Reply to {input.replyTo}</small> : null}
                {input.error ? <p className="composer-inbox-body">{input.error}</p> : null}
              </details></td>
          </tr>)}</tbody>
        </table> : <div className="composer-inbox-empty" role="status">{inbox.snapshot || entries.length ? "No recent messages." : inbox.error ? "Use Refresh to try again." : "Loading inbox…"}</div>}
      </div>
    </div>
  </>;
}
