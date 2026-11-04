import { useEffect, useMemo, useRef, useState } from "react";
import {
  StoredManagedModificationResultReferenceSchema,
  type ManagedModificationExecution,
} from "openpond-sdk/training";
import { ErrorToast } from "../../common/ErrorToast";
import { modelsLocation } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useManagedModificationClient } from "./managed-modification-api";
import { createWorkspaceApi, type WorkspaceApi } from "./workspace-api";
import {
  inspectionSupportsNeuronTraining,
  inspectionTrainingCoordinates,
  neuronTrainingInspectionDraft,
} from "./neuron-training-inspection-draft";

export function TrainSelectedNeurons({
  execution,
  api,
  disabled = false,
}: {
  execution: ManagedModificationExecution;
  api: WorkspaceApi;
  disabled?: boolean;
}) {
  const setup = useEvaluationSetup();
  const bound = useMemo(
    () =>
      createWorkspaceApi(api.connection, {
        teamId: api.teamId,
        actorId: api.actorId,
        accountKey: api.accountKey,
        projectId: execution.projectId,
        executionLocation: "hosted",
      }),
    [api.key, execution.projectId],
  );
  const client = useManagedModificationClient(bound, inspectionSupportsNeuronTraining(execution));
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const scope = JSON.stringify([bound.key, execution.id, execution.result?.contentHash]),
    live = useRef(scope);
  live.current = scope;
  useEffect(() => {
    live.current = scope;
    setSelected([]);
    setBusy(false);
    setError(null);
    return () => {
      live.current = "";
    };
  }, [scope]);
  const coordinates = useMemo(() => inspectionTrainingCoordinates(execution), [execution]);
  if (!inspectionSupportsNeuronTraining(execution) || !coordinates.length) return null;
  const chosen = coordinates.filter((row) => selected.includes(`${row.layer}:${row.neuron}`));
  async function open() {
    if (busy || disabled || !client.data || !chosen.length) return;
    setBusy(true);
    setError(null);
    try {
      const current = await client.data.get(execution.id);
      if (live.current !== scope) return;
      if (current.result?.contentHash !== execution.result?.contentHash)
        throw new Error("Refresh the original inspection before selecting its neurons.");
      const reference = StoredManagedModificationResultReferenceSchema.parse({
        kind: "managed_modification_result",
        location: "cloud",
        apiOrigin: client.data.account.apiOrigin,
        owner: { teamId: bound.teamId, actorId: bound.actorId },
        projectId: current.projectId,
        executionId: current.id,
        method: current.method,
        inputHash: current.plan.inputHash,
        runtimeHash: current.plan.runtimeHash,
        resultHash: current.result!.contentHash,
      });
      const draft = await neuronTrainingInspectionDraft(current, chosen, reference);
      if (live.current !== scope) return;
      await setup.openDraft(
        draft,
        modelsLocation("experiments", null, {
          projectId: current.projectId,
          executionLocation: "hosted",
        }),
      );
    } catch (cause) {
      if (live.current === scope) setError(cause);
    } finally {
      if (live.current === scope) setBusy(false);
    }
  }
  return (
    <section aria-label="Train neurons from inspection">
      <ErrorToast error={error ?? client.error} />
      <div className="evaluation-table-wrap">
        <table className="evaluation-table">
          <caption>Neurons observed under Off</caption>
          <thead>
            <tr>
              <th scope="col">Select</th>
              <th scope="col">Layer</th>
              <th scope="col">Neuron</th>
            </tr>
          </thead>
          <tbody>
            {coordinates.map((row) => {
              const key = `${row.layer}:${row.neuron}`,
                checked = selected.includes(key);
              return (
                <tr key={key}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Train layer ${row.layer} neuron ${row.neuron}`}
                      checked={checked}
                      disabled={busy || disabled || (!checked && selected.length >= 128)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, key]
                            : current.filter((value) => value !== key),
                        )
                      }
                    />
                  </td>
                  <td>{row.layer}</td>
                  <td>{row.neuron}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        {chosen.length} selected. The editor retains this inspection and exact base; choose reviewed
        target and background data before Run.
      </p>
      <button
        type="button"
        className="training-button secondary"
        disabled={busy || disabled || !client.isSuccess || !chosen.length}
        onClick={() => void open()}
      >
        {busy ? "Opening experiment…" : "Train selected neurons"}
      </button>
    </section>
  );
}
