import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LocalAdapterPublicationStateSchema, type LocalAdapterPublicationRequest } from "@openpond/contracts/resource-setup";
import { apiFetch } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import { connectionQueryScope } from "../../lib/query-scope";
import { AppDialog } from "../dialogs/AppDialog";
import { formatBytes } from "./LabModelTrainingActivity";
import type { WorkspaceApi } from "./workspace/workspace-api";

function versionUrl(base: string | null, modelId: string, artifactId: string) {
  if (!base) return null;
  try {
    const target = new URL(`/console/models/${encodeURIComponent(modelId)}/versions/${encodeURIComponent(artifactId)}`, base);
    return target.protocol === "https:" && !target.username && !target.password ? target.href : null;
  } catch { return null; }
}

export function LocalAdapterPublicationAction({ api, profileId, version, hostedWebBaseUrl, name }: {
  api: WorkspaceApi;
  profileId: string;
  version: LocalAdapterPublicationRequest["version"];
  hostedWebBaseUrl: string | null;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const queries = useQueryClient();
  const key = ["local-adapter-publication", connectionQueryScope(api.connection), api.key, profileId, version] as const;
  async function request(action: "preview" | "upload", reviewHash?: string, signal?: AbortSignal) {
    return LocalAdapterPublicationStateSchema.parse(await apiFetch(api.connection, `/v1/training/local-adapter-publication/${action}`, {
      method: "POST", body: JSON.stringify({ teamId: api.teamId, actorId: api.actorId, profileId, version, reviewHash }), signal,
    }));
  }
  const review = useQuery({ queryKey: key, enabled: open, queryFn: ({ signal }) => request("preview", undefined, signal), retry: false, staleTime: 0 });
  const upload = useMutation({ mutationFn: (reviewHash: string) => request("upload", reviewHash), onSuccess: state => queries.setQueryData(key, state) });
  useErrorToast(review.error ?? upload.error, { enabled: open });
  const state = review.data;
  const hosted = state?.state === "registered" ? state.version : null;
  const link = hosted ? versionUrl(hostedWebBaseUrl, hosted.modelProjectId, hosted.artifact.id) : null;
  const close = () => { if (!upload.isPending) { setOpen(false); upload.reset(); } };
  return <>
    <button type="button" className="training-button secondary" onClick={() => setOpen(true)}>Upload to workspace</button>
    {open ? <AppDialog ariaLabel={`Upload ${name} adapter`} className="labs-rename-dialog labs-serving-dialog" onClose={close} dismissDisabled={upload.isPending}>
      <h2>{hosted ? "Adapter saved to workspace" : "Review LoRA upload"}</h2>
      {review.isFetching && !state ? <p role="status">Checking the saved adapter and hosted Model…</p> : null}
      {state?.state === "review" ? <dl className="training-configuration-list">
        <div><dt>Model</dt><dd>{state.modelName}</dd></div>
        <div><dt>Workspace</dt><dd>{api.teamId}</dd></div>
        <div><dt>Base Model</dt><dd>{state.baseRepository}</dd></div>
        <div><dt>Base revision</dt><dd><code>{state.baseRevision}</code></dd></div>
        <div><dt>Saved version</dt><dd><code>{state.localVersionHash}</code></dd></div>
        <div><dt>Adapter SHA-256</dt><dd><code>{state.adapterSha256}</code></dd></div>
        <div><dt>Upload size</dt><dd>{formatBytes(state.bytes)}</dd></div>
      </dl> : null}
      {hosted ? <dl className="training-configuration-list">
        <div><dt>Hosted version</dt><dd><code>{hosted.contentHash}</code></dd></div>
        <div><dt>Registry artifact</dt><dd><code>{hosted.artifact.id}</code></dd></div>
      </dl> : null}
      <footer className="training-dialog-actions">
        <button type="button" className="training-button secondary" disabled={upload.isPending} onClick={close}>Close</button>
        {(review.isError || upload.isError) ? <button type="button" className="training-button secondary" disabled={review.isFetching}
          onClick={() => { upload.reset(); void review.refetch(); }}>Refresh review</button> : null}
        {state?.state === "review" && !review.isError && !upload.isError ? <button type="button" className="training-button"
          disabled={upload.isPending || review.isFetching} onClick={() => upload.mutate(state.reviewHash)}>{upload.isPending ? "Uploading adapter…" : "Upload adapter"}</button> : null}
        {link ? <a className="training-button" href={link} target="_blank" rel="noopener noreferrer">Open serving options</a> : null}
      </footer>
    </AppDialog> : null}
  </>;
}
