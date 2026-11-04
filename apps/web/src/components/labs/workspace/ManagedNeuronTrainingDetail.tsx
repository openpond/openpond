import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ErrorToast } from "../../common/ErrorToast";
import { useManagedNeuronTrainingClient } from "./managed-neuron-training-api";
import { createWorkspaceApi } from "./workspace-api";
import { useManagedNeuronTrainingExperiment } from "./useManagedNeuronTrainingExperiment";
import { ManagedNeuronTrainingExecution } from "./ManagedNeuronTrainingExecution";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { useDraftNavigation } from "../useDraftNavigation";
import type { WorkspaceApi } from "./workspace-api";

/** Canonical history opens the execution itself; no mutable draft is required
 * to read a retained result or reconcile an original paid control. */
export function ManagedNeuronTrainingDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const client = useManagedNeuronTrainingClient(api);
  const source = useQuery({
    queryKey: ["neuron-training-detail-source", api.key, id],
    enabled: Boolean(client.data),
    retry: false,
    queryFn: ({ signal }) => {
      if (!client.data) throw new Error("Load this execution's original account first.");
      return client.data.get(id, signal);
    },
  });
  const bound = useMemo(
    () =>
      source.data
        ? createWorkspaceApi(api.connection, {
            teamId: api.teamId,
            actorId: api.actorId,
            accountKey: api.accountKey,
            projectId: source.data.projectId,
            executionLocation: "hosted",
          })
        : null,
    [api.key, api.connection, source.data?.projectId],
  );
  return (
    <>
      <ErrorToast error={source.error ?? client.error} />
      {bound ? (
        <NeuronTrainingDetail key={`${bound.key}:${id}`} api={bound} id={id} />
      ) : (
        <>
          {!source.error && !client.error && (source.isPending || client.isPending) ? (
            <p role="status">Loading execution scope…</p>
          ) : null}
          <button
            type="button"
            className="training-button secondary"
            onClick={() => {
              void client.refetch();
              void source.refetch();
            }}
          >
            Retry execution read
          </button>
        </>
      )}
    </>
  );
}
function NeuronTrainingDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const owner = useManagedNeuronTrainingExperiment(api, {
    draftId: null,
    executionId: id,
    visible: true,
  });
  useWorkspaceResourceName(owner.execution?.name ?? "Neuron training experiment");
  const guard = useDraftNavigation({
    name: "Neuron training execution",
    busy: owner.busy,
    dirty: false,
  });
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1>{owner.execution?.name ?? "Neuron training experiment"}</h1>
      </header>
      <ManagedNeuronTrainingExecution api={api} owner={owner} />
      {guard.dialog}
    </>
  );
}
