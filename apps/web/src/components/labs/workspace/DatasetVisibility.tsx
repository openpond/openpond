import { EvaluationCard, EvaluationStatus } from "./EvaluationPresentation";
import { useState } from "react";
import { useDraftNavigation } from "../useDraftNavigation";
import { useQuery } from "@tanstack/react-query";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import { CatalogMetadata, type OpenPondDatasetMarketplaceClient } from "openpond-sdk/dataset-marketplace";
import type { WorkspaceApi } from "./workspace-api";
import { WorkspacePanel } from "./WorkspacePanel";
type Visibility = Awaited<ReturnType<OpenPondDatasetMarketplaceClient["visibility"]>>;

export function DatasetVisibility({ api, dataset, onClose }: { api: WorkspaceApi; dataset: DatasetWorkspaceReceipt; onClose: () => void }) {
  const publication = dataset.publication!;
  const state = useQuery({ queryKey: ["evaluation-workspace", api.key, "marketplaceVisibility", publication.tasksetId], queryFn: ({ signal }) => api.request<Visibility>("marketplaceVisibility", { id: publication.tasksetId }, signal) });
  const [fields, setFields] = useState<{ slug: string; title: string; description: string; license: string; sourceUrl: string; attribution: string; category: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedMetadata = { slug: state.data?.summary?.metadata.slug ?? "", title: state.data?.summary?.metadata.title ?? dataset.workspace.draft.name, description: state.data?.summary?.metadata.description ?? "", license: state.data?.summary?.metadata.license ?? "", sourceUrl: state.data?.summary?.metadata.sourceUrl ?? "", attribution: state.data?.summary?.metadata.attribution ?? "", category: state.data?.summary?.metadata.category ?? "" };
  const metadata = fields ?? savedMetadata;
  const guard = useDraftNavigation({ name: "marketplace listing", dirty: JSON.stringify(metadata) !== JSON.stringify(savedMetadata) || consent, busy });
  async function publish() {
    if (!state.data || busy) return; setBusy(true); setError(null);
    try {
      const input = { tasksetId: publication.tasksetId, release: publication.release, packageHash: publication.packageHash, expectedVisibilityRevision: state.data.visibilityRevision, metadata: CatalogMetadata.parse({ ...metadata, sourceUrl: metadata.sourceUrl.trim() || null }), distributionConsent: true };
      const operation = api.operation("marketplacePublish", input);
      await api.request("marketplacePublish", { ...input, operationId: operation.id });
      operation.acknowledge(); await state.refetch(); setConsent(false); setFields(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function withdraw() {
    if (!state.data?.summary || busy) return; setBusy(true); setError(null);
    try {
      const input = { releaseId: state.data.summary.id, expectedVisibilityRevision: state.data.visibilityRevision, visibility: "private" };
      const operation = api.operation("marketplaceChangeVisibility", input);
      await api.request("marketplaceChangeVisibility", { ...input, operationId: operation.id });
      operation.acknowledge(); await state.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <>{guard.dialog}<WorkspacePanel action="visibility" label="Dataset marketplace visibility">
    <header><h2>Marketplace visibility</h2><button disabled={busy} onClick={() => void guard.requestLeave(onClose)}>Close</button></header>
    {state.error || error ? <p role="alert">{error ?? state.error?.message}</p> : null}
    {state.isPending ? <p role="status">Loading released Dataset…</p> : null}
    {state.data ? <>
      <EvaluationCard title="Released Dataset">
        <p>{dataset.workspace.draft.name} · Revision {publication.release.revision}</p>
        <p><EvaluationStatus status={state.data.visibility === "public" ? "Public" : "Private"} /></p>
        <p>{state.data.taskCount} tasks · {state.data.fileCount} retained files · {state.data.sizeBytes.toLocaleString()} bytes</p>
      </EvaluationCard>
      {state.data.visibility === "public" ? <EvaluationCard title="Marketplace visibility">
        <p>Making this release private removes public discovery and future imports. Existing imports retain their pinned Dataset and graders.</p>
        <button className="training-button secondary" disabled={busy} onClick={() => void withdraw()}>{busy ? "Updating visibility…" : "Make private"}</button>
      </EvaluationCard> : <>
        <EvaluationCard title="Marketplace listing">
          {([ ["slug", "Dataset URL name"], ["title", "Title"], ["description", "Description"], ["category", "Category"], ["license", "License"], ["attribution", "Attribution"], ["sourceUrl", "Source URL (optional)"] ] as const).map(([key, label]) => <label key={key}>{label}{key === "description" || key === "attribution" ? <textarea value={metadata[key]} disabled={busy} onChange={event => setFields({ ...metadata, [key]: event.target.value })} /> : <input value={metadata[key]} disabled={busy} onChange={event => setFields({ ...metadata, [key]: event.target.value })} />}</label>)}
        </EvaluationCard>
        <EvaluationCard title="Distribution consent">
          <p>Publishing distributes this released Dataset and its complete included grader assets and fixtures. Review private reference answers, licenses and attribution before sharing.</p>
          <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /> I can distribute this exact release, its reference answers and included grader assets under the stated license.</label>
          <button className="training-button" disabled={busy || !consent} onClick={() => void publish()}>{busy ? "Publishing exact release…" : "Publish to marketplace"}</button>
        </EvaluationCard>
      </>}
    </> : null}
  </WorkspacePanel></>;
}
