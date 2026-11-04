import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ErrorToast } from "../../common/ErrorToast";
import { useManagedDecisionClient } from "./managed-decision-api";
import { createWorkspaceApi } from "./workspace-api";
import { useManagedDecisionExperiment } from "./useManagedDecisionExperiment";
import { ManagedDecisionExecution } from "./ManagedDecisionExecution";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { useDraftNavigation } from "../useDraftNavigation";
import type { WorkspaceApi } from "./workspace-api";

/** Canonical history opens the execution itself; no mutable draft is required
 * to read a retained result or reconcile an original paid control. */
export function ManagedDecisionDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const client = useManagedDecisionClient(api);
  const source = useQuery({
    queryKey: ["decision-detail-source", api.key, id],
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
        <DecisionDetail key={`${bound.key}:${id}`} api={bound} id={id} />
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
function DecisionDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const owner = useManagedDecisionExperiment(api, {
    draftId: null,
    executionId: id,
    visible: true,
  });
  useWorkspaceResourceName(owner.execution?.name ?? "Decision experiment");
  const guard = useDraftNavigation({
    name: "Decision execution",
    busy: owner.busy,
    dirty: false,
  });
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1>{owner.execution?.name ?? "Decision experiment"}</h1>
      </header>
      <ManagedDecisionExecution api={api} owner={owner} />
      {guard.dialog}
    </>
  );
}
