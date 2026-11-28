import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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

type Props = { api: WorkspaceApi; modelId: string; name: string; versionHash?: string; onClose(): void };

export function HostedModelServeAction({ api, modelId, name, active = false, compact = false }: Omit<Props, "onClose" | "versionHash"> & {
  active?: boolean;
  compact?: boolean;
}) {
  const [reviewing, setReviewing] = useState(false);
  const label = active ? "Manage" : "Serve";
  return <div className="labs-serve-action" onClick={event => event.stopPropagation()}>
    <button type="button" className={`training-button${compact ? " secondary labs-compact-button" : ""}`}
      aria-label={`${label} ${name}`} onClick={() => setReviewing(true)}>
      {label}
    </button>
    {reviewing ? <HostedModelServingSetup key={`${api.key}:${modelId}`} api={api} modelId={modelId} name={name}
      onClose={() => setReviewing(false)} /> : null}
  </div>;
}

/** Open only on Serve. Closed table rows perform no per-model state reads. */
export function HostedModelServingSetup(props: Props) {
  const { api, modelId, versionHash } = props;
  const query = useQuery({
    queryKey: ["inference-model-preparation", api.key, connectionQueryScope(api.connection), modelId, versionHash],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ teamId: api.teamId });
      if (versionHash) query.set("versionHash", versionHash);
      else query.set("preferActiveServing", "true");
      return parseAndVerifySavedModelVersionRead(await apiFetch(api.connection,
        `/v1/training/saved-models/${encodeURIComponent(modelId)}/version?${query}`, { signal }), api.teamId, modelId, versionHash);
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: current => current.state.error || current.state.data?.version ? false : 5_000,
  });
  if (query.data?.version) return <PreparedServing {...props} version={query.data.version} />;
  return <PreparationDialog {...props}>
    <ErrorToast error={query.error} />
    {query.isPending ? <p role="status">Preparing your model…</p> : query.isSuccess ? <p>Save a Model version to review serving.</p> : null}
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
