import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ErrorToast } from "../../common/ErrorToast";
import { useManagedAlphaEditClient } from "./managed-alphaedit-api";
import { createWorkspaceApi } from "./workspace-api";
import { useManagedAlphaEditExperiment } from "./useManagedAlphaEditExperiment";
import { ManagedAlphaEditExecution } from "./ManagedAlphaEditExecution";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { useDraftNavigation } from "../useDraftNavigation";
import type { WorkspaceApi } from "./workspace-api";

/** Canonical history opens the execution itself; no mutable draft is required
 * to read a retained result or reconcile an original paid control. */
export function ManagedAlphaEditDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const client = useManagedAlphaEditClient(api);
  const source = useQuery({
    queryKey: ["alphaedit-detail-source", api.key, id],
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
        <AlphaEditDetail key={`${bound.key}:${id}`} api={bound} id={id} />
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
function AlphaEditDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const owner = useManagedAlphaEditExperiment(api, {
    draftId: null,
    executionId: id,
    visible: true,
  });
  useWorkspaceResourceName(owner.execution?.name ?? "AlphaEdit experiment");
  const guard = useDraftNavigation({
    name: "AlphaEdit execution",
    busy: owner.busy,
    dirty: false,
  });
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1>{owner.execution?.name ?? "AlphaEdit experiment"}</h1>
      </header>
      <ManagedAlphaEditExecution api={api} owner={owner} />
      {guard.dialog}
    </>
  );
}
