import { EvaluationCard } from "./EvaluationPresentation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CatalogSummary, CatalogAdoptionReceipt } from "openpond-sdk/dataset-marketplace";
import type { WorkspaceApi } from "./workspace-api";
import { WorkspacePanel } from "./WorkspacePanel";

export function DiscoverDatasets({ api, onClose, onImported }: { api: WorkspaceApi; onClose: () => void; onImported: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [after, setAfter] = useState<string | undefined>();
  const [selectedId, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = useQuery({ queryKey: ["evaluation-workspace", api.key, "marketplaceCategories"], queryFn: ({ signal }) => api.request<{ categories: string[] }>("marketplaceCategories", {}, signal) });
  const browse = useQuery({ queryKey: ["evaluation-workspace", api.key, "marketplaceBrowse", search, category, after], queryFn: ({ signal }) => api.request<{ items: CatalogSummary[]; nextCursor: string | null }>("marketplaceBrowse", { search, ...(category ? { category } : {}), limit: 25, ...(after ? { after } : {}) }, signal) });
  const detail = useQuery({ queryKey: ["evaluation-workspace", api.key, "marketplaceDetail", selectedId], enabled: Boolean(selectedId), queryFn: ({ signal }) => api.request<{ summary: CatalogSummary; versions: CatalogSummary[] }>("marketplaceDetail", { id: selectedId }, signal) });
  const preview = useQuery({ queryKey: ["evaluation-workspace", api.key, "marketplacePreview", selectedId], enabled: Boolean(selectedId), queryFn: ({ signal }) => api.request<{ items: Array<{ id: string; split: string; input: Record<string, unknown> }> }>("marketplacePreview", { id: selectedId }, signal) });
  async function adopt() {
    if (!detail.data || busy) return;
    setBusy(true); setError(null);
    try {
      const summary = detail.data.summary;
      const input = { releaseId: summary.id, release: summary.release, packageHash: summary.packageHash, ...(api.projectId ? { projectId: api.projectId } : {}) };
      const operation = await api.operation("marketplaceAdopt", input);
      const receipt = await api.request<CatalogAdoptionReceipt>("marketplaceAdopt", { ...input, operationId: operation.id });
      await operation.acknowledge(); onImported(receipt.tasksetId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <WorkspacePanel action="discover" label="Discover Datasets" onRequestClose={() => { if(!busy)onClose(); }}><header><h2>Discover Datasets</h2></header>{error || categories.error || browse.error || detail.error || preview.error ? <p role="alert">{error ?? categories.error?.message ?? browse.error?.message ?? detail.error?.message ?? preview.error?.message}</p> : null}{selectedId ? <><button className="training-text-button" disabled={busy} onClick={() => setSelected(null)}>All datasets</button>{detail.isPending ? <p role="status">Loading dataset…</p> : null}{detail.data ? <><EvaluationCard title={detail.data.summary.metadata.title}><p>{detail.data.summary.metadata.description}</p><p>{detail.data.summary.taskCount} tasks · {detail.data.summary.graders.length} graders · {detail.data.summary.publisherName}</p><p>{detail.data.summary.metadata.license}</p><ul>{detail.data.summary.graders.map(grader => <li key={grader.id}>{grader.id} · {grader.kind} · {grader.readiness}</li>)}</ul><label>Published version<select disabled={busy} value={selectedId} onChange={event => setSelected(event.target.value)}>{detail.data.versions.map(version => <option key={version.id} value={version.id}>Revision {version.release.revision}</option>)}</select></label><details><summary>Preview tasks</summary>{preview.data?.items.map(task => <section key={task.id}><h4>{task.id} · {task.split}</h4><pre>{JSON.stringify(task.input, null, 2)}</pre></section>)}</details></EvaluationCard><button className="training-button" disabled={busy} onClick={() => void adopt()}>{busy ? "Importing exact release…" : "Import dataset"}</button></> : null}</> : <><div className="evaluation-workspace-filters"><label>Search<input aria-label="Search datasets" placeholder="Search datasets" value={search} onChange={event => { setSearch(event.target.value); setAfter(undefined); }} /></label><label>Category<select aria-label="Dataset category" value={category} disabled={categories.isPending} onChange={event => { setCategory(event.target.value); setAfter(undefined); }}><option value="">All</option>{categories.data?.categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>{browse.isPending ? <p role="status">Loading datasets…</p> : null}<div className="evaluation-dataset-choices">{browse.data?.items.map(item => <button key={item.id} className="training-button secondary" onClick={() => setSelected(item.id)}><strong>{item.metadata.title}</strong><span>{item.metadata.description}</span><small>{item.taskCount} tasks · {item.graders.length} graders · {item.publisherName}</small></button>)}</div>{browse.data?.items.length === 0 ? <p>No matching datasets.</p> : null}{after ? <button onClick={() => setAfter(undefined)}>First page</button> : null}{browse.data?.nextCursor ? <button onClick={() => setAfter(browse.data!.nextCursor!)}>More datasets</button> : null}</>}</WorkspacePanel>;
}
