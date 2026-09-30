import { DatasetVersions } from "./DatasetVersions";
import { HostedDatasetEditor } from "./HostedDatasetEditor";
import { WorkspacePanel } from "./WorkspacePanel";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import type { ModelsRoute } from "../models-route";
import type { Inventory, WorkspaceApi } from "./workspace-api";
export function HostedDatasetsPage({ api, inventory, route, navigate, onLocalDatasets, onRefresh }: { api: WorkspaceApi; inventory: Inventory | null; route: ModelsRoute; navigate: (route: ModelsRoute) => void; onLocalDatasets: () => void; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useQuery({ queryKey: ["evaluation-workspace", api.key, "dataset", route.resourceId], enabled: Boolean(route.resourceId), queryFn: ({ signal }) => api.request<DatasetWorkspaceReceipt>("dataset", { id: route.resourceId }, signal) });
  const [versionRevision, setVersionRevision] = useState<number | null>(null);
  const version = useQuery({ queryKey: ["evaluation-workspace", api.key, "datasetVersion", route.resourceId, versionRevision], enabled: Boolean(route.resourceId && versionRevision), queryFn: ({ signal }) => api.request<DatasetWorkspaceReceipt>("datasetVersion", { id: route.resourceId, revision: versionRevision }, signal) });
  const dataset = versionRevision ? version.data : selected.data;
  const tab = route.detailTab ?? "tasks";
  const task = dataset?.workspace.draft.tasks.find(item => item.id === taskId);
  async function upload() {
    if (busy) return; setBusy(true); setError(null);
    try {
      const folder = window.openpond?.selectFolder ? await window.openpond.selectFolder() : { canceled: false, path: importPath };
      if (folder.canceled || !folder.path) return;
      const operation = api.operation("uploadFolder", { path: folder.path });
      const value = await api.request<DatasetWorkspaceReceipt>("uploadFolder", { directory: folder.path, operationId: operation.id });
      operation.acknowledge(); onRefresh(); navigate({ ...route, resourceId: value.datasetId, detailTab: "tasks" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function beginVersion() {
    if (!selected.data || busy) return; setBusy(true); setError(null);
    try { const operation = api.operation("beginDatasetVersion", { id: selected.data.datasetId, revision: selected.data.revision });
      await api.request("beginDatasetVersion", { id: selected.data.datasetId, request: { operationId: operation.id, expectedRevision: selected.data.revision } });
      operation.acknowledge(); setVersionRevision(null); await selected.refetch(); onRefresh(); setEditing(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function publish() {
    if (!dataset || busy) return; setBusy(true); setError(null);
    try {
      const validated = await api.request<{ workspaceHash: string; packageHash: string }>("validateDataset", { id: dataset.datasetId, expectedRevision: dataset.revision });
      const operation = api.operation("publishDataset", { id: dataset.datasetId, revision: dataset.revision, hash: validated.packageHash });
      await api.request("publishDataset", { id: dataset.datasetId, request: { operationId: operation.id, expectedRevision: dataset.revision, workspaceHash: validated.workspaceHash, packageHash: validated.packageHash } });
      operation.acknowledge(); await selected.refetch(); onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <><header className="evaluation-workspace-header"><h1>{dataset?.workspace.draft.name ?? "Datasets"}</h1>{dataset && dataset.workspace.draft.status === "draft" ? <button className="training-button" disabled={busy} onClick={() => void publish()}>{busy ? "Checking…" : "Check and publish"}</button> : null}<button className="training-button" disabled={busy || Boolean(versionRevision)} onClick={() => dataset?.workspace.draft.status === "published" ? void beginVersion() : setEditing(true)}>{dataset?.workspace.draft.status === "published" ? "Create editable version" : dataset ? "Edit draft" : "+ Dataset"}</button><button className="training-button secondary" disabled={busy} onClick={() => void upload()}>Import authored folder</button><button className="training-button secondary" onClick={onLocalDatasets}>Local authoring and import</button></header>
    {!window.openpond?.selectFolder ? <label>Authored folder path <input value={importPath ?? ""} onChange={event => setImportPath(event.target.value)} /></label> : null}
    {selected.error || version.error || error ? <p role="alert">{selected.error?.message ?? version.error?.message ?? error}</p> : null}
    {versionRevision ? <p role="status">Viewing immutable published version. <button onClick={() => { setVersionRevision(null); setTaskId(null); }}>Return to current workspace</button></p> : null}
    {dataset ? <><p>{dataset.publication ? `Published revision ${dataset.publication.release.revision}` : "Draft"} · {dataset.workspace.draft.tasks.length} tasks</p><nav className="evaluation-workspace-tabs" aria-label="Dataset tabs">{["tasks", "experiments", "graders", "versions"].map(value => <button key={value} aria-selected={tab === value} onClick={() => { setTaskId(null); navigate({ ...route, detailTab: value }); }}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
      {tab === "tasks" ? <table className="training-data-table evaluation-workspace-table"><thead><tr><th>Task</th><th>Input</th><th>Split</th></tr></thead><tbody>{dataset.workspace.draft.tasks.map(item => <tr key={item.id} tabIndex={0} onClick={() => setTaskId(item.id)} onKeyDown={event => { if (event.key === "Enter") setTaskId(item.id); }}><td>{item.id}</td><td>{JSON.stringify(item.input).slice(0, 200)}</td><td>{item.split}</td></tr>)}</tbody></table> : tab === "experiments" ? <ul>{inventory?.experiments.items.filter(item => item.request.taskset.contentHash === dataset.publication?.release.contentHash).map(item => <li key={item.id}><button className="training-text-button" onClick={() => navigate({ ...route, page: "experiments", resourceId: item.id, detailTab: "overview" })}>{item.request.name}</button></li>)}</ul> : tab === "graders" ? <pre>{JSON.stringify(dataset.workspace.draft.graders, null, 2)}</pre> : <><DatasetVersions api={api} datasetId={dataset.datasetId} onSelect={revision => { setVersionRevision(revision); setTaskId(null); navigate({ ...route, detailTab: "tasks" }); }} /><dl className="evaluation-workspace-meta"><dt>Workspace revision</dt><dd>{dataset.revision}</dd><dt>Workspace hash</dt><dd>{dataset.workspace.contentHash}</dd><dt>Published release</dt><dd>{dataset.publication?.release.id ?? "Unpublished"}</dd><dt>Release hash</dt><dd>{dataset.publication?.release.contentHash ?? "Unpublished"}</dd><dt>Package hash</dt><dd>{dataset.publication?.packageHash ?? "Unpublished"}</dd></dl></>}
    </> : <><label>Search datasets <input value={route.query} onChange={event => navigate({ ...route, query: event.target.value, after: null })} /></label><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Dataset</th><th>Status</th><th>Revision</th><th>Updated</th></tr></thead><tbody>{inventory?.datasets.datasets.filter(item => item.name.toLowerCase().includes(route.query.toLowerCase())).map(item => <tr key={item.id} tabIndex={0} onClick={() => navigate({ ...route, resourceId: item.id, detailTab: "tasks" })} onKeyDown={event => { if (event.key === "Enter") navigate({ ...route, resourceId: item.id, detailTab: "tasks" }); }}><td>{item.name}</td><td>{item.status}</td><td>{item.revision}</td><td>{new Date(item.updatedAt).toLocaleDateString()}</td></tr>)}</tbody></table>{inventory && !inventory.datasets.datasets.length ? <p>No hosted datasets in this Project.</p> : null}</>}
    {editing ? <HostedDatasetEditor api={api} existing={dataset ?? null} onClose={() => setEditing(false)} onSaved={id => { setEditing(false); onRefresh(); navigate({ ...route, resourceId: id, detailTab: "tasks" }); }} /> : null}
    {task && !editing ? <WorkspacePanel label="Task inspector"><header><h2>{task.id}</h2><button onClick={() => setTaskId(null)}>Close</button></header><h3>Input</h3><pre>{JSON.stringify(task.input, null, 2)}</pre><h3>Task details</h3><pre>{JSON.stringify(task, null, 2)}</pre></WorkspacePanel> : null}
  </>;
}
