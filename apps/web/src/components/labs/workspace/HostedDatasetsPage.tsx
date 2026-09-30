import { EvaluationCard, EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { useWorkspaceActions, useWorkspacePanelControls } from "./WorkspacePanel";
import { DatasetVisibility } from "./DatasetVisibility";
import { DiscoverDatasets } from "./DiscoverDatasets";
import { ReleasedDatasetDetail } from "./ReleasedDatasetDetail";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { DatasetExperiments } from "./DatasetExperiments";
import { DatasetTaskCheckbox, DatasetTaskSelection, useDatasetTaskSelection } from "./DatasetTaskSelection";
import { DatasetGraders } from "./DatasetGraders";
import { DatasetVersions } from "./DatasetVersions";
import { HostedDatasetEditor } from "./HostedDatasetEditor";
import { WorkspacePanel } from "./WorkspacePanel";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import { draftPublishIssues } from "openpond-sdk/taskset-drafts";
import type { ModelsRoute } from "../models-route";
import type { Inventory, WorkspaceApi } from "./workspace-api";
export function HostedDatasetsPage({ api, inventory, route, navigate, onLocalDatasets, onRefresh }: { api: WorkspaceApi; inventory: Inventory | null; route: ModelsRoute; navigate: (route: ModelsRoute) => void; onLocalDatasets: () => void; onRefresh: () => void }) {
  const controls = useWorkspacePanelControls();
  const [editing, setEditing] = useState(false);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useQuery({ queryKey: ["evaluation-workspace", api.key, "dataset", route.resourceId], enabled: Boolean(route.resourceId && route.datasetKind !== "release"), queryFn: ({ signal }) => api.request<DatasetWorkspaceReceipt>("dataset", { id: route.resourceId }, signal) });
  const versionRevision = route.revision ?? null;
  const version = useQuery({ queryKey: ["evaluation-workspace", api.key, "datasetVersion", route.resourceId, versionRevision, route.contentHash], enabled: Boolean(route.resourceId && versionRevision), queryFn: async ({ signal }) => { const value = await api.request<DatasetWorkspaceReceipt>("datasetVersion", { id: route.resourceId, revision: versionRevision }, signal); if (value.publication?.release.contentHash !== route.contentHash) throw new Error("Dataset version differs from its pinned release."); return value; } });
  const dataset = versionRevision ? version.data : selected.data;
  const tab = route.detailTab ?? "tasks";
  const executableRelease = dataset?.workspace.draft.status === "published" ? dataset.publication?.release ?? null : null;
  useDatasetTaskSelection(executableRelease);
  const task = dataset?.workspace.draft.tasks.find(item => item.id === taskId);
  function closeEditor(id?: string) {
    setEditing(false); onRefresh();
    if (id === route.resourceId) void selected.refetch();
    if (id) navigate({ ...route, resourceId: id, detailTab: "tasks" });
  }
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
      operation.acknowledge(); navigate({ ...route, revision: undefined, contentHash: undefined }); await selected.refetch(); onRefresh(); setEditing(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function publish() {
    if (!dataset || busy) return; setBusy(true); setError(null);
    try {
      const issues = draftPublishIssues(dataset.workspace.draft);
      if (issues.length) throw new Error(issues.map(issue => issue.message).join(" "));
      const validated = await api.request<{ workspaceHash: string; packageHash: string }>("validateDataset", { id: dataset.datasetId, expectedRevision: dataset.revision });
      const operation = api.operation("publishDataset", { id: dataset.datasetId, revision: dataset.revision, hash: validated.packageHash });
      await api.request("publishDataset", { id: dataset.datasetId, request: { operationId: operation.id, expectedRevision: dataset.revision, workspaceHash: validated.workspaceHash, packageHash: validated.packageHash } });
      operation.acknowledge(); await selected.refetch(); onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  function inspectTask(id: string) {
    setTaskId(id);
    controls?.select({ id: "task", label: "Task", onSelect: () => {} });
  }
  const selectSidebarAction = useWorkspaceActions([
    ...(task ? [{ id: "task", label: "Task", onSelect: () => {} }] : []),
    { id: "discover", label: "Discover", onSelect: () => setDiscovering(true) },
    ...(dataset?.publication ? [{ id: "visibility", label: "Visibility", onSelect: () => setVisibilityOpen(true) }] : []),
    ...(!versionRevision && route.datasetKind !== "release" ? [{ id: "dataset", label: "Dataset", onSelect: () => { if (!editing && !busy && !selected.isFetching) { if (dataset?.workspace.draft.status === "published") void beginVersion(); else setEditing(true); } } }] : []),
  ]);
  const released = inventory?.releasedDatasets.items.filter(item => !inventory.datasets.datasets.some(workspace => workspace.publication?.tasksetId === item.id)) ?? [];
  useWorkspaceResourceName(dataset?.workspace.draft.name ?? (selected.error ? "Unavailable dataset" : null));
  const discoverPanel = discovering ? <DiscoverDatasets api={api} onClose={() => setDiscovering(false)} onImported={id => { setDiscovering(false); onRefresh(); navigate({ ...route, resourceId: id, datasetKind: "release", detailTab: "tasks" }); }} /> : null;
  if (route.datasetKind === "release" && route.resourceId) return <><ReleasedDatasetDetail api={api} inventory={inventory} route={route} navigate={navigate} />{discoverPanel}</>;
  return <><header className="evaluation-workspace-header"><h1>{dataset?.workspace.draft.name ?? "Datasets"}</h1>{dataset && dataset.workspace.draft.status === "draft" ? <button className="training-button" disabled={busy || selected.isFetching} onClick={() => void publish()}>{busy ? "Checking…" : "Check and publish"}</button> : null}<button className="training-button" disabled={busy || selected.isFetching || Boolean(versionRevision)} onClick={() => selectSidebarAction("dataset")}>{dataset?.workspace.draft.status === "published" ? "Create editable version" : dataset ? "Edit draft" : "+ Dataset"}</button>{dataset?.publication ? <button className="training-button secondary" onClick={() => selectSidebarAction("visibility")}>Marketplace visibility</button> : null}<button className="training-button secondary" disabled={busy} onClick={() => selectSidebarAction("discover")}>Discover datasets</button><button className="training-button secondary" disabled={busy} onClick={() => void upload()}>Import authored folder</button><button className="training-button secondary" onClick={onLocalDatasets}>Local authoring and import</button></header>
    {!window.openpond?.selectFolder ? <label>Authored folder path <input value={importPath ?? ""} onChange={event => setImportPath(event.target.value)} /></label> : null}
    {selected.error || version.error || error ? <p role="alert">{selected.error?.message ?? version.error?.message ?? error}</p> : null}
    {versionRevision ? <p role="status">Viewing immutable published version. <button onClick={() => { navigate({ ...route, revision: undefined, contentHash: undefined }); setTaskId(null); }}>Return to current workspace</button></p> : null}
    {dataset ? <><p>{dataset.publication ? `Published revision ${dataset.publication.release.revision}` : "Draft"} · {dataset.workspace.draft.tasks.length} tasks</p><nav className="evaluation-workspace-tabs" aria-label="Dataset tabs">{["tasks", "experiments", "graders", "versions"].map(value => <button key={value} aria-selected={tab === value} onClick={() => { setTaskId(null); navigate({ ...route, detailTab: value }); }}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
      {tab === "tasks" ? <>{executableRelease ? <DatasetTaskSelection release={executableRelease} count={dataset.workspace.draft.tasks.length} route={route} /> : null}<table className="training-data-table evaluation-workspace-table"><thead><tr>{executableRelease ? <th scope="col">Select</th> : null}<th>Task</th><th>Input</th><th>Split</th></tr></thead><tbody>{dataset.workspace.draft.tasks.map(item => <tr key={item.id} tabIndex={0} onClick={() => inspectTask(item.id)} onKeyDown={event => { if (event.key === "Enter") inspectTask(item.id); }}>{executableRelease ? <DatasetTaskCheckbox release={executableRelease} id={item.id} /> : null}<td>{item.id}</td><td>{JSON.stringify(item.input).slice(0, 200)}</td><td>{item.split}</td></tr>)}</tbody></table></> : tab === "experiments" ? <DatasetExperiments api={api} releaseHash={dataset.publication?.release.contentHash ?? null} route={route} navigate={navigate} /> : tab === "graders" ? null : <><DatasetVersions api={api} datasetId={dataset.datasetId} onSelect={(revision, publication) => { setTaskId(null); navigate({ ...route, revision: revision ?? undefined, contentHash: publication?.release.contentHash, detailTab: "tasks" }); }} /><dl className="evaluation-workspace-meta"><dt>Workspace revision</dt><dd>{dataset.revision}</dd><dt>Workspace hash</dt><dd>{dataset.workspace.contentHash}</dd><dt>Published release</dt><dd>{dataset.publication?.release.id ?? "Unpublished"}</dd><dt>Release hash</dt><dd>{dataset.publication?.release.contentHash ?? "Unpublished"}</dd><dt>Package hash</dt><dd>{dataset.publication?.packageHash ?? "Unpublished"}</dd></dl></>}
      <div hidden={tab !== "graders"}><DatasetGraders key={`${dataset.datasetId}:${dataset.revision}`} api={api} dataset={dataset} readOnly={Boolean(versionRevision) || dataset.workspace.draft.status !== "draft"} onSaved={() => { void selected.refetch(); onRefresh(); }} /></div>
    </> : <><label>Search datasets <input value={route.query} onChange={event => navigate({ ...route, query: event.target.value, after: null })} /></label><label>Sort datasets<select value={route.sort ?? "name"} onChange={event => navigate({ ...route, sort: event.target.value as "id" | "name" | "updated", after: null })}><option value="name">Name</option><option value="updated">Latest update</option><option value="id">Dataset identity</option></select></label><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Dataset</th><th>Status</th><th>Revision</th><th>Updated</th></tr></thead><tbody>{inventory?.datasets.datasets.map(item => <tr key={item.id} tabIndex={0} onClick={() => navigate({ ...route, resourceId: item.id, detailTab: "tasks" })} onKeyDown={event => { if (event.key === "Enter") navigate({ ...route, resourceId: item.id, detailTab: "tasks" }); }}><td>{item.name}</td><td><EvaluationStatus status={item.status} /></td><td>{item.revision}</td><td><EvaluationTime value={item.updatedAt} /></td></tr>)}{released.map(item => <tr key={item.id} tabIndex={0} onClick={() => navigate({ ...route, resourceId: item.id, datasetKind: "release", detailTab: "tasks" })} onKeyDown={event => { if (event.key === "Enter") navigate({ ...route, resourceId: item.id, datasetKind: "release", detailTab: "tasks" }); }}><td>{item.name}</td><td><EvaluationStatus status="Published" /></td><td>{item.release.revision}</td><td><EvaluationTime value={item.createdAt} /></td></tr>)}</tbody></table>{inventory && !inventory.datasets.datasets.length && !released.length ? <p>No hosted datasets in this Project.</p> : null}{route.after ? <button onClick={() => navigate({ ...route, after: null })}>First dataset page</button> : null}{inventory?.datasets.nextCursor ? <button onClick={() => navigate({ ...route, after: `workspace:${inventory.datasets.nextCursor}` })}>More authored datasets</button> : null}{inventory?.releasedDatasets.nextCursor ? <button onClick={() => navigate({ ...route, after: `catalog:${inventory.releasedDatasets.nextCursor}` })}>More released datasets</button> : null}</>}
    {visibilityOpen && dataset?.publication ? <DatasetVisibility api={api} dataset={dataset} onClose={() => setVisibilityOpen(false)} /> : null}
    {discoverPanel}
    {editing ? <HostedDatasetEditor api={api} existing={dataset ?? null} onClose={closeEditor} onSaved={closeEditor} /> : null}
    {task ? <WorkspacePanel action="task" label="Task inspector"><header><h2>{task.id}</h2><button onClick={() => setTaskId(null)}>Close</button></header><EvaluationCard title="Input"><pre>{JSON.stringify(task.input, null, 2)}</pre></EvaluationCard><EvaluationCard title="Task details"><pre>{JSON.stringify(task, null, 2)}</pre></EvaluationCard></WorkspacePanel> : null}
  </>;
}
