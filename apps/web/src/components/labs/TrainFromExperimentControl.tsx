import { useEffect, useState } from "react";
import {
  TrainingHandoffContextSchema,
  type TrainingHandoffContext,
  type TrainingHandoffOrigin,
} from "openpond-sdk/post-training";
import { apiFetch, type ClientConnection } from "../../api/api-client";
export function TrainFromExperimentControl({
  connection,
  teamId,
  actorId,
  executionId,
  passId = null,
  onOpen,
}: {
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  executionId: string;
  passId?: string | null;
  onOpen: (origin: TrainingHandoffOrigin) => void;
}) {
  const scope = JSON.stringify([
    connection.serverUrl,
    connection.token,
    teamId,
    actorId,
    executionId,
    passId,
  ]);
  const [retained, setRetained] = useState<{ scope: string; value: TrainingHandoffContext } | null>(
      null,
    ),
    [error, setError] = useState<string | null>(null);
  const value = retained?.scope === scope ? retained.value : null;
  useEffect(() => {
    let stopped = false;
    setError(null);
    const params = new URLSearchParams({ teamId, executionId });
    if (passId) params.set("passId", passId);
    void apiFetch(connection, `/v1/training/experiment-handoff?${params}`)
      .then((raw) => {
        const next = TrainingHandoffContextSchema.parse(raw);
        if (
          next.origin &&
          (next.origin.teamId !== teamId ||
            next.origin.source.executionId !== executionId ||
            next.origin.source.passId !== passId)
        )
          throw new Error("The retained handoff belongs to another result.");
        if (!stopped) setRetained({ scope, value: next });
      })
      .catch((reason) => {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : "Training context is unavailable.");
      });
    return () => {
      stopped = true;
    };
  }, [connection, teamId, actorId, executionId, passId, scope]);
  return (
    <div>
      <button
        disabled={!value?.available || !value.origin}
        onClick={() => {
          if (value?.origin) onOpen(value.origin);
        }}
      >
        Train from result
      </button>
      {error || value?.reason ? (
        <p role={error ? "alert" : undefined}>{error ?? value?.reason}</p>
      ) : null}
    </div>
  );
}
