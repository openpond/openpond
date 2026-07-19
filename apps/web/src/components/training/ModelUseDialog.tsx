import { useEffect, useMemo, useState } from "react";
import type {
  FireworksModelServingSession,
  ModelArtifactLineage,
  Taskset,
} from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import {
  buildTrainingModelChatHandoff,
  type TrainingModelChatHandoff,
} from "../../lib/training-model-chat-handoff";
import { Loader2, MessageSquare, X } from "../icons";

type TrainingController = ReturnType<typeof useTraining>;

export function ModelUseDialog({
  lineage,
  taskset,
  training,
  onChat,
  onClose,
}: {
  lineage: ModelArtifactLineage;
  taskset: Taskset;
  training: TrainingController;
  onChat: (handoff: TrainingModelChatHandoff) => void;
  onClose: () => void;
}) {
  const [startAndChat, setStartAndChat] = useState(false);
  const sessions = useMemo(
    () => (training.payload?.servingSessions ?? [])
      .filter((session) => session.modelArtifactLineageId === lineage.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [lineage.id, training.payload?.servingSessions],
  );
  const session = sessions[0] ?? null;
  const active = session
    && ["starting", "ready", "stopping"].includes(session.state)
    ? session
    : null;
  const busy = Boolean(training.busyAction);

  useEffect(() => {
    if (!startAndChat || session?.state !== "ready") return;
    onChat(buildTrainingModelChatHandoff({
      modelId: lineage.id,
      taskset,
    }));
    onClose();
  }, [lineage.id, onChat, onClose, session?.state, startAndChat, taskset]);

  async function start(): Promise<void> {
    setStartAndChat(true);
    const started = await training.actions.startModelServing(lineage.id);
    if (!started) setStartAndChat(false);
  }

  async function stop(
    target: FireworksModelServingSession,
  ): Promise<void> {
    setStartAndChat(false);
    await training.actions.stopModelServing(target.id);
  }

  function chat(): void {
    onChat(buildTrainingModelChatHandoff({
      modelId: lineage.id,
      taskset,
    }));
    onClose();
  }

  return (
    <div
      className="training-dialog-backdrop"
      role="presentation"
      onMouseDown={busy ? undefined : onClose}
    >
      <section
        aria-label={`Use ${taskset.name}`}
        aria-modal="true"
        className="training-dialog training-model-use-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div>
            <h2>Use model</h2>
            <p>{taskset.name}</p>
          </div>
          <button
            aria-label="Close model use"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="training-model-use-summary">
          <div>
            <span>Compute</span>
            <strong>1× H100</strong>
          </div>
          <div>
            <span>Rate</span>
            <strong>$7.00/hour</strong>
          </div>
          <div>
            <span>Idle stop</span>
            <strong>5 minutes</strong>
          </div>
          <div>
            <span>Hard stop</span>
            <strong>10 minutes · $1.17 max</strong>
          </div>
        </div>

        {!lineage.promotable ? (
          <p className="training-model-use-warning">
            This run did not pass its frozen Eval. Chat is available for
            inspection, but the model cannot be promoted.
          </p>
        ) : null}

        {session ? (
          <ServingStatus session={session} />
        ) : (
          <p className="training-model-use-note">
            Start a temporary Fireworks deployment, attach this LoRA, then
            open a chat. OpenPond tears it down on idle, at the hard limit, or
            when you press Stop.
          </p>
        )}

        {training.error ? (
          <div className="training-banner error">{training.error}</div>
        ) : null}

        <div className="training-dialog-actions">
          {active ? (
            <button
              className="training-button secondary"
              disabled={busy || active.state === "stopping"}
              type="button"
              onClick={() => void stop(active)}
            >
              {active.state === "stopping" ? "Stopping…" : "Stop serving"}
            </button>
          ) : (
            <button
              className="training-button secondary"
              disabled={busy}
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
          )}
          {session?.state === "ready" ? (
            <button
              className="training-button"
              disabled={busy}
              type="button"
              onClick={chat}
            >
              <MessageSquare size={14} />
              Chat now
            </button>
          ) : active?.state === "starting" ? (
            <button className="training-button" disabled type="button">
              <Loader2 className="spin" size={14} />
              Starting…
            </button>
          ) : (
            <button
              className="training-button"
              disabled={busy}
              type="button"
              onClick={() => void start()}
            >
              {busy && startAndChat ? (
                <Loader2 className="spin" size={14} />
              ) : null}
              Start &amp; chat
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function ServingStatus({
  session,
}: {
  session: FireworksModelServingSession;
}) {
  const stateLabel = session.state === "starting"
    ? "Starting Fireworks serving"
    : session.state === "ready"
      ? "Ready to chat"
      : session.state === "stopping"
        ? "Stopping Fireworks serving"
        : session.state === "stopped"
          ? "Serving stopped"
          : "Serving failed";
  const estimated = `$${session.estimatedCostUsd.toFixed(4)}`;
  return (
    <div className={`training-model-serving-status ${session.state}`}>
      <div>
        <strong>{stateLabel}</strong>
        <span>Estimated serving cost {estimated}</span>
      </div>
      {session.state === "starting" || session.state === "stopping" ? (
        <div className="training-model-serving-progress" aria-label={stateLabel}>
          <span />
        </div>
      ) : null}
      {session.stoppedAt ? (
        <small>
          Stopped {new Date(session.stoppedAt).toLocaleString()}
          {session.stopReason ? ` · ${stopReasonLabel(session.stopReason)}` : ""}
        </small>
      ) : null}
      {session.error ? <small className="error">{session.error}</small> : null}
    </div>
  );
}

function stopReasonLabel(
  reason: FireworksModelServingSession["stopReason"],
): string {
  if (reason === "idle") return "idle limit";
  if (reason === "duration") return "10-minute limit";
  if (reason === "budget") return "cost limit";
  if (reason === "restart_cleanup") return "app restart cleanup";
  if (reason === "startup_error") return "startup error";
  if (reason === "shutdown") return "app shutdown";
  return "stopped by user";
}
