import type { PonderDesktopHandoffPresentation } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { PonderHandoffEditControl } from "./PonderHandoffEditControl";

export function PonderHandoffActivity({
  items,
  onOpenTask,
  onCancel,
  cancelling,
  connection,
  onEdited,
}: {
  items: PonderDesktopHandoffPresentation[];
  onOpenTask: (
    item: PonderDesktopHandoffPresentation,
    sessionId: string,
  ) => void;
  onCancel: (item: PonderDesktopHandoffPresentation) => void;
  cancelling: string | null;
  connection: ClientConnection;
  onEdited: () => Promise<void>;
}) {
  if (!items.length) return null;
  return (
    <section className="ponder-linked-work" aria-label="Agent workflows">
      {items.map((item) => (
        <article key={item.id}>
          <strong>{item.title}</strong>
          <p>
            {item.cancellationRequested || item.workflow?.preparationCleanupPending
              ? "Cancellation requested; awaiting the actual stop outcome."
              : item.state === "waiting"
                ? "Waiting for the implementation and its validated source before review."
                : item.state === "ready"
                  ? "Implementation verified; starting the review on desktop."
                  : item.state === "dispatching"
                    ? "Starting the review on desktop."
                    : item.state === "admitted"
                      ? "Review task started; waiting for its findings."
                      : item.state === "attention"
                        ? "The implementation needs attention before review can start."
                        : item.state === "blocked"
                          ? "Workflow needs attention."
                          : item.state === "completed" ? "Review completed."
                            : item.state === "failed" ? "Review failed."
                              : "Workflow stopped."}
          </p>
          {item.waitingForDesktop && (
            <p>
              Reconnect the original desktop under the same account and
              workspace.
            </p>
          )}
          {item.reason && <p>{item.reason}</p>}
          <small>
            {item.successor.modelId ?? item.successor.providerId} ·{" "}
            {item.successor.workspaceLabel}
          </small>
          {item.workflow ? <p>
            {item.workflow.preparationSessionId
              ? "Reviewer created for the checklist and implementation handoff."
              : ["failed", "cancelled", "expired", "attention"].includes(item.workflow.preparationState)
                ? "Reviewer preparation needs attention."
                : "Waiting to create the reviewer for its checklist."}{" "}
            {item.workflow.sourceReady ? "Validated implementation is ready for review." : "Review waits for the validated implementation."}
          </p> : null}
          <details>
            <summary>Success criteria</summary>
            <p>{item.successCriteria}</p>
          </details>
          {item.prerequisite.sessionId && (
            <button
              type="button"
              onClick={() => onOpenTask(item, item.prerequisite.sessionId!)}
            >
              {item.workflow ? "Open implementation task" : "Open original task"}
            </button>
          )}
          {!item.successor.sessionId && item.workflow?.preparationSessionId && (
            <button type="button" onClick={() => onOpenTask(item, item.workflow!.preparationSessionId!)}>
              Open reviewer task
            </button>
          )}
          {item.successor.sessionId && (
            <button
              type="button"
              onClick={() => onOpenTask(item, item.successor.sessionId!)}
            >
              {item.workflow ? "Open reviewer task" : "Open successor task"}
            </button>
          )}
          {item.canCancel && (
            <button
              type="button"
              disabled={cancelling !== null}
              onClick={() => onCancel(item)}
            >
              {cancelling === item.id
                ? "Requesting cancellation…"
                : "Cancel handoff"}
            </button>
          )}
          {item.canEdit && (
            <PonderHandoffEditControl
              connection={connection}
              item={item}
              onSaved={onEdited}
            />
          )}
        </article>
      ))}
    </section>
  );
}
