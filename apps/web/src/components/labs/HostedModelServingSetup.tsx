import { useQuery } from "@tanstack/react-query";
import {
  parseAndVerifySavedModelVersionRead,
  parseAndVerifySavedModelServing,
  type SavedModelVersion,
} from "openpond-sdk/training";
import { apiFetch } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { AppDialog } from "../dialogs/AppDialog";
import { ModelServingControlDialog } from "./ModelServingControlDialog";
import type { WorkspaceApi } from "./workspace/workspace-api";

type Props = { api: WorkspaceApi; modelId: string; name: string; onClose(): void };

/** Open only on Serve. Closed table rows perform no per-model state reads. */
export function HostedModelServingSetup(props: Props) {
  const { api, modelId } = props;
  const query = useQuery({
    queryKey: ["inference-model-preparation", api.key, connectionQueryScope(api.connection), modelId],
    queryFn: async ({ signal }) => {
      const saved = await parseAndVerifySavedModelVersionRead(await apiFetch(api.connection,
        `/v1/training/saved-models/${encodeURIComponent(modelId)}/version?${new URLSearchParams({ teamId: api.teamId, preferActiveServing: "true" })}`,
        { signal }), api.teamId, modelId);
      return saved;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: current => current.state.error || current.state.data?.version ? false : 5_000,
  });
  if (query.data?.version) return <PreparedServing {...props} version={query.data.version} />;
  return <PreparationDialog {...props}>
    <ErrorToast error={query.error} />
    {query.isPending ? <p role="status">Preparing your model…</p> : query.isSuccess ? <p>Waiting for a completed training checkpoint.</p> : null}
    {!query.isPending ? <button type="button" className="training-button secondary" onClick={() => void query.refetch()}>Refresh checkpoint</button> : null}
  </PreparationDialog>;
}

function PreparedServing(props: Props & { version: SavedModelVersion }) {
  const { api, version } = props;
  const query = useQuery({
    queryKey: ["inference-serving-review", api.key, connectionQueryScope(api.connection), version.contentHash],
    queryFn: async ({ signal }) => parseAndVerifySavedModelServing(await apiFetch(api.connection,
      `/v1/training/saved-models/${encodeURIComponent(version.modelProjectId)}/serving?${new URLSearchParams({ teamId: api.teamId, versionHash: version.contentHash })}`, { signal }),
    { teamId: api.teamId, modelProjectId: version.modelProjectId, versionHash: version.contentHash }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  if (query.data) return <ModelServingControlDialog api={api} value={query.data} version={version}
    action={query.data.control?.desiredState === "active" ? "stop" : "activate"} onClose={props.onClose} />;
  return <PreparationDialog {...props}>
    <ErrorToast error={query.error} />
    {query.isPending ? <p role="status">Loading serving price…</p> : <button type="button" className="training-button secondary" onClick={() => void query.refetch()}>Retry serving review</button>}
  </PreparationDialog>;
}

function PreparationDialog({ name, onClose, busy = false, children }: Props & { busy?: boolean; children: React.ReactNode }) {
  return <AppDialog ariaLabel={`Serve ${name}`} className="labs-rename-dialog labs-serving-dialog" dismissDisabled={busy} onClose={onClose}>
    <h2>Serve {name}</h2>
    {children}
    <button type="button" className="training-button secondary" disabled={busy} onClick={onClose}>Close</button>
  </AppDialog>;
}
