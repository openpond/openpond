import { useState } from "react";
import type { TaskInput } from "@openpond/contracts";
import type { TaskInboxController } from "../../hooks/useTaskInbox";
import { composerSteerPreview } from "./composer-steer-queue";

export function TaskInboxPanel({ inbox, onRestore }: { inbox: TaskInboxController; onRestore(body: string): void }) {
  const [editing, setEditing] = useState<{ input: TaskInput; body: string } | null>(null);
  const snapshot = inbox.snapshot;
  const queued = snapshot?.inputs.filter((input) => input.senderKind === "user" && input.kind === "queued" && input.state === "pending") ?? [];
  const activity = snapshot?.inputs.filter((input) => input.state !== "cancelled" && !queued.some((queuedInput) => queuedInput.id === input.id)).slice(-8) ?? [];
  const edit = editing?.input.sessionId === snapshot?.sessionId ? editing : null;
  if (!queued.length && !activity.length && !snapshot?.waits.length && !inbox.error) return null;
  return <section className="task-inbox-panel" aria-label="Task inbox">
    {inbox.error && <p className="task-inbox-error" role="alert">{inbox.error} <button type="button" onClick={() => void inbox.refresh()}>Refresh</button></p>}
    {snapshot?.waits.map((wait) => <p className="task-inbox-status" role="status" key={wait.id}>
      {wait.targetSessionId ? `Waiting for task ${wait.targetSessionId}` : "Waiting for a message"}. Work resumes when an update arrives.
    </p>)}
    {queued.length > 0 && <>
      <div className="task-inbox-heading"><span>{queued.length} queued</span>
        {snapshot?.paused && <span>Paused — messages stay saved</span>}
        {!snapshot?.activeTurnId && <button type="button" disabled={Boolean(inbox.busyId)} onClick={() => void inbox.mutate(queued[0]!, { action: "resume", expectedRevision: queued[0]!.revision })}>Resume queue</button>}
      </div>
      {queued.map((input) => <div key={input.id} className="task-inbox-item">
        {edit?.input.id === input.id ? <>
          <textarea aria-label="Edit queued message" value={edit.body} maxLength={32_000} onChange={(event) => setEditing({ ...edit, body: event.target.value })} />
          <div className="task-inbox-actions">
            <button type="button" disabled={!edit.body.trim() || Boolean(inbox.busyId)} onClick={async () => {
              if (await inbox.mutate(edit.input, { action: "edit", expectedRevision: edit.input.revision, body: edit.body })) setEditing(null);
            }}>Save changes</button>
            <button type="button" onClick={() => setEditing(null)}>Cancel edit</button>
          </div>
        </> : <>
          <p title={input.body}>{composerSteerPreview(input.body, 220)}</p>
          <div className="task-inbox-actions">
            <span>{input.turnId ? "Starting" : "Next turn"}</span>
            <button type="button" disabled={Boolean(inbox.busyId) || Boolean(input.turnId) || !snapshot?.acceptingInput} onClick={() => void inbox.mutate(input, { action: "steer", expectedRevision: input.revision, expectedTurnId: snapshot!.activeTurnId! })}>Steer now</button>
            <button type="button" disabled={Boolean(inbox.busyId) || Boolean(input.turnId)} onClick={() => setEditing({ input, body: input.body })}>Edit</button>
            <button type="button" disabled={Boolean(inbox.busyId) || Boolean(input.turnId)} onClick={() => void inbox.mutate(input, { action: "cancel", expectedRevision: input.revision })}>Delete</button>
          </div>
        </>}
      </div>)}
    </>}
    {activity.length > 0 && <details className="task-inbox-activity" open={activity.some((input) => input.state === "rejected" || Boolean(input.error))}><summary>Messages and delivery ({activity.length})</summary>
      {activity.map((input) => <div className="task-inbox-item" key={input.id}>
        <div className="task-inbox-heading"><span>{input.senderKind === "user" ? "Your instruction" : input.senderKind === "runtime" ? "Task update" : `Task ${input.senderSessionId}`}</span><span>{deliveryLabel(input)}</span></div>
        <p>{composerSteerPreview(input.body, 320)}</p>
        {input.error && <p className="task-inbox-error">{input.error}</p>}
        {(input.state === "rejected" || input.error) && input.senderKind === "user" && <button type="button" onClick={() => onRestore(input.body)}>Use as follow-up</button>}
      </div>)}
      <p className="task-inbox-status">Delivery shows when input reached a model request. It does not confirm understanding or a reply.</p>
    </details>}
  </section>;
}

function deliveryLabel(input: TaskInput): string {
  if (input.state === "pending") return "Saved · pending delivery";
  if (input.state === "included") return "Included";
  if (input.state === "resolved") return "Request finished";
  if (input.state === "rejected") return "Not delivered";
  return "Cancelled";
}
