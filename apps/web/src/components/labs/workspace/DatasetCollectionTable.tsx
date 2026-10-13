import { useLocalLearningCatalog, useProjectLocalProfiles, localDatasetsForProject, profileDisplayName } from "./local-learning-catalog";
import { EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { EvaluationTableState } from "./EvaluationTableState";
import type { Inventory, WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function DatasetCollectionTable({ api, inventory, route, navigate, loading, error, retry }: {
  api: WorkspaceApi; inventory: Inventory | null; route: ModelsRoute; navigate: (value: ModelsRoute) => void;
  loading?: boolean; error?: string; retry: () => void;
}) {
  const local = useLocalLearningCatalog(api);
  const associations = useProjectLocalProfiles(api);
  const authored = inventory?.datasets.datasets ?? [];
  const authoredReleaseIds = new Set(authored.flatMap(row => row.publication ? [row.publication.tasksetId] : []));
  const released = (inventory?.releasedDatasets.items ?? []).filter(row => !authoredReleaseIds.has(row.id));
  const association = (releaseId: string | null) => inventory?.projects.projects.flatMap(project => project.content.targets)
    .flatMap(entry => entry.target.kind === "harness" ? [entry.target.source] : entry.target.kind === "suite" ? entry.target.sources : [])
    .find(source => source.externalDatasetBinding?.dataset.id === releaseId);
  const rows = [
    ...authored.map(item => ({ key: `hosted:${item.id}`, id: item.id, name: item.name, status: item.status === "draft" ? "Not published" : item.status,
      revision: item.revision, updatedAt: item.updatedAt, location: "hosted" as const, release: false, source: association(item.publication?.release.id ?? null) })),
    ...released.map(item => ({ key: `hosted-release:${item.id}`, id: item.id, name: item.name, status: "Published", revision: item.release.revision,
      updatedAt: item.createdAt, location: "hosted" as const, release: true, source: association(item.release.id) })),
    ...localDatasetsForProject(local.data ?? [], api, inventory, associations.data ?? []).filter(item => !route.query || item.summary.name.toLowerCase().includes(route.query.toLowerCase()))
      .map(item => ({ key: `local:${item.summary.id}`, id: item.summary.id, name: item.summary.name, status: item.summary.state,
        revision: item.summary.revision, updatedAt: item.updatedAt, location: "local" as const, release: false,
        source: item.profileTarget ? { profileId: item.profileTarget.profileId, target: item.profileTarget.workflowId ? { kind: "workflow" as const, workflowId: item.profileTarget.workflowId } : null } : null })),
  ].sort((a, b) => route.sort === "updated" ? b.updatedAt.localeCompare(a.updatedAt) : route.sort === "id" ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name));
  const open = (row: typeof rows[number]) => navigate({ ...route, resourceId: row.id, executionLocation: row.location,
    datasetKind: row.release ? "release" : undefined, detailTab: "tasks", revision: undefined, contentHash: undefined, after: null });
  return <>
    {associations.error ? <p role="alert">Desktop Profile associations: {associations.error.message} <button className="training-text-button" onClick={() => void associations.refetch()}>Retry</button></p> : null}
    {error ? <p role="alert">Hosted datasets: {error} <button className="training-text-button" onClick={retry}>Retry</button></p> : null}
    {local.error ? <p role="alert">Desktop datasets: {local.error.message} <button className="training-text-button" onClick={() => void local.refetch()}>Retry</button></p> : null}
    <div className="evaluation-table-scroll evaluation-table-frame"><table className="training-data-table evaluation-workspace-table evaluation-resource-table">
      <thead><tr><th>Dataset</th><th>Profile</th><th>Workflow</th><th>Status</th><th>Revision</th><th>Updated</th><th>Location</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} tabIndex={0} onClick={() => open(row)} onKeyDown={event => { if (event.key === "Enter") open(row); }}>
        <td><span className="evaluation-cell-text" title={row.name}>{row.name}</span></td><td>{profileDisplayName(row.source?.profileId)}</td>
        <td>{row.source?.target?.kind === "workflow" ? row.source.target.workflowId : "—"}</td><td><EvaluationStatus status={row.status} /></td>
        <td>{row.revision}</td><td><EvaluationTime value={row.updatedAt} /></td><td>{row.location === "local" ? "Desktop" : "Hosted"}</td>
      </tr>)}<EvaluationTableState columns={7} loading={!rows.length && (loading || local.isPending || Boolean(api.projectId && associations.isPending))} empty={!rows.length}>Create or discover a Dataset.</EvaluationTableState></tbody>
    </table></div>
  </>;
}
