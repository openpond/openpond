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
    <section className="ponder-linked-work" aria-label="Completion handoffs">
      {items.map((item) => (
        <article key={item.id}>
          <strong>{item.title}</strong>
          <p>
            {item.cancellationRequested
              ? "Cancellation requested; awaiting the actual stop outcome."
              : item.state === "waiting"
                ? "Waiting for the original task’s verified result."
                : item.state === "ready"
                  ? "Prerequisite verified; awaiting desktop admission."
                  : item.state === "dispatching"
                    ? "Desktop claimed the successor; reconciling admission."
                    : item.state === "admitted"
                      ? "Successor admitted; awaiting its result."
                      : item.state === "attention"
                        ? "The prerequisite needs review before its successor can start."
                        : item.state === "blocked"
                          ? "Handoff blocked."
                          : `Handoff ${item.state}.`}
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
          <details>
            <summary>Success criteria</summary>
            <p>{item.successCriteria}</p>
          </details>
          {item.prerequisite.sessionId && (
            <button
              type="button"
              onClick={() => onOpenTask(item, item.prerequisite.sessionId!)}
            >
              Open original task
            </button>
          )}
          {item.successor.sessionId && (
            <button
              type="button"
              onClick={() => onOpenTask(item, item.successor.sessionId!)}
            >
              Open successor task
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
