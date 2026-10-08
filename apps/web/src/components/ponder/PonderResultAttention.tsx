import { useEffect, useRef, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import type { PonderLinkedLocalWork } from "./ponder-local-work";
import type { PonderLocalOutputSource } from "./ponder-local-output";

export type PonderLinkedWork = {
  conversationId: string;
  title: string;
  status: string;
  deliveries: Array<{
    inputId: string;
    ponderTurnId: string | null;
    status: "claimed" | "acknowledged" | "attention";
    attentionAt: string | null;
    attentionReason: string | null;
    outputs: Array<{ id: string; title: string }>;
  }>;
};

export function PonderResultAttention({
  connection,
  work,
  localWork,
  busy,
  onOpenWork,
  onOpenLocalWork,
  onOpenLocalOutput,
  onOpenOutput,
}: {
  connection: ClientConnection;
  work: readonly PonderLinkedWork[];
  localWork: readonly PonderLinkedLocalWork[];
  busy: boolean;
  onOpenWork: (conversationId: string) => void;
  onOpenLocalWork: (source: PonderLinkedLocalWork) => void;
  onOpenLocalOutput: (
    source: PonderLocalOutputSource,
    outputId: string,
  ) => void;
  onOpenOutput: (outputId: string) => void;
}) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const context = useRef({ connection, mounted: true, inFlight: false });
  if (context.current.connection !== connection)
    context.current = { connection, mounted: true, inFlight: false };
  useEffect(() => {
    const scope = context.current;
    scope.mounted = true;
    setRetrying(null);
    setError(null);
    return () => {
      scope.mounted = false;
    };
  }, [connection]);
  const pending = [
    ...work.flatMap((task) =>
      task.deliveries
        .filter(
          (delivery) => delivery.status === "attention" && delivery.attentionAt,
        )
        .map((delivery) => ({ task, delivery, kind: "hosted" as const })),
    ),
    ...localWork.flatMap((task) =>
      task.deliveries
        .filter(
          (delivery) => delivery.status === "attention" && delivery.attentionAt,
        )
        .map((delivery) => ({ task, delivery, kind: "local" as const })),
    ),
  ];
  async function retry(delivery: PonderLinkedWork["deliveries"][number]) {
    const scope = context.current;
    if (!delivery.attentionAt || scope.inFlight) return;
    const current = () => scope.mounted && context.current === scope;
    scope.inFlight = true;
    setRetrying(delivery.inputId);
    setError(null);
    try {
      await apiFetch(connection, "/v1/ponder/results/retry", {
        method: "POST",
        body: JSON.stringify({
          inputId: delivery.inputId,
          attentionAt: delivery.attentionAt,
          priorTurnId: delivery.ponderTurnId,
        }),
      });
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error &&
            cause.message === "hosted_work_model_not_available"
            ? "The selected model is unavailable. Choose an available model, then retry."
            : "The discussion could not be started. Refresh and try again.",
        );
    } finally {
      scope.inFlight = false;
      if (current()) setRetrying(null);
    }
  }
  if (pending.length === 0) return null;
  return (
    <section aria-label="Saved results needing discussion" aria-live="polite">
      {pending.map((item) => (
        <div className="ponder-desktop-attention" key={item.delivery.inputId}>
          <p>
            The result from{" "}
            <button
              type="button"
              onClick={() =>
                item.kind === "hosted"
                  ? onOpenWork(item.task.conversationId)
                  : onOpenLocalWork(item.task)
              }
            >
              {item.task.title}
            </button>{" "}
            is saved.
            {item.delivery.attentionReason === "model_unavailable"
              ? " The selected model was unavailable."
              : item.delivery.attentionReason === "chat_cancelled"
                ? " The discussion was cancelled."
                : " The discussion failed."}
          </p>
          {item.delivery.outputs.map((output) => (
            <button
              key={output.id}
              type="button"
              onClick={() =>
                item.kind === "local"
                  ? onOpenLocalOutput(
                      { ...item.task, turnId: item.delivery.localTurnId },
                      output.id,
                    )
                  : onOpenOutput(output.id)
              }
            >
              {output.title} · Download
            </button>
          ))}
          <button
            type="button"
            disabled={busy || retrying !== null}
            onClick={() => void retry(item.delivery)}
          >
            {retrying === item.delivery.inputId
              ? "Starting discussion…"
              : "Retry discussion"}
          </button>
        </div>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
