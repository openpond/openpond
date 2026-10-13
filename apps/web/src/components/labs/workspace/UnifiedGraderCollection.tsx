import { inlineErrorMessage } from "../../../lib/error-messages";
import type { z } from "zod";
import type { GraderCatalogPageSchema } from "openpond-sdk/learning";
import { useLocalLearningCatalog, useProjectLocalProfiles, localDatasetsForProject, profileDisplayName } from "./local-learning-catalog";
import { EvaluationTableState } from "./EvaluationTableState";
import type { Inventory, WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";

type HostedGrader = z.infer<typeof GraderCatalogPageSchema>["items"][number];
export function UnifiedGraderCollection({ api, inventory, route, navigate, items, loading, error, retry, kind, sort }: {
  api: WorkspaceApi; inventory?: Inventory | null; route: ModelsRoute; navigate: (value: ModelsRoute) => void;
  items: HostedGrader[]; loading: boolean; error?: string; retry: () => void; kind: string; sort: string;
}) {
  const local = useLocalLearningCatalog(api);
  const associations = useProjectLocalProfiles(api);
  const localRows = localDatasetsForProject(local.data ?? [], api, inventory, associations.data ?? []).flatMap(dataset => dataset.graders.map(grader => ({ dataset, grader })))
    .filter(({ grader }) => (!kind || grader.kind === kind) && (!route.query || `${grader.name} ${grader.graderId}`.toLowerCase().includes(route.query.toLowerCase())));
  const rows = [
    ...items.map(({ reward, projects, datasets, runs }) => ({ key: `hosted:${reward.id}`, name: reward.name, kind: reward.implementation.kind, version: String(reward.revision),
      profile: "—", workflow: "—", dataset: "—", checks: "Published", location: "hosted" as const, id: reward.id,
      projects, datasets, runs, revision: reward.revision, hash: reward.contentHash })),
    ...localRows.map(({ dataset, grader }) => ({ key: `local:${grader.id}`, name: grader.name, kind: grader.kind, version: grader.version,
      profile: profileDisplayName(dataset.profileTarget?.profileId), workflow: dataset.profileTarget?.workflowId ?? "—",
      dataset: dataset.summary.name, checks: grader.checkState, location: "local" as const, id: grader.id,
      projects: dataset.projectId ? 1 : null, datasets: 1, runs: null, revision: dataset.summary.revision, hash: grader.configurationHash })),
  ].sort((a, b) => (["projects", "datasets", "runs"].includes(sort) ? (b[sort as "projects" | "datasets" | "runs"] ?? -1) - (a[sort as "projects" | "datasets" | "runs"] ?? -1) : sort === "type" ? a.kind.localeCompare(b.kind) : sort === "version" ? Number(b.version) - Number(a.version) : a.name.localeCompare(b.name)) || a.key.localeCompare(b.key));
  const open = (row: typeof rows[number]) => navigate({ ...route, resourceId: row.id, executionLocation: row.location,
    revision: row.revision, contentHash: row.hash, detailTab: "overview", after: null });
  return <>
    {associations.error && inlineErrorMessage(associations.error) ? <p role="alert">Desktop Profile associations: {associations.error.message} <button className="training-text-button" onClick={() => void associations.refetch()}>Retry</button></p> : null}
    {error && inlineErrorMessage(error) ? <p role="alert">Hosted graders: {error} <button className="training-text-button" onClick={retry}>Retry</button></p> : null}
    {local.error && inlineErrorMessage(local.error) ? <p role="alert">Desktop graders: {local.error.message} <button className="training-text-button" onClick={() => void local.refetch()}>Retry</button></p> : null}
    <div className="evaluation-table-scroll evaluation-table-frame"><table className="training-data-table evaluation-workspace-table evaluation-resource-table">
      <thead><tr><th>Grader</th><th>Profile</th><th>Workflow</th><th>Type</th><th>Version</th><th>Dataset</th><th>Checks</th><th>Location</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} tabIndex={0} onClick={() => open(row)} onKeyDown={event => { if (event.key === "Enter") open(row); }}>
        <td><span className="evaluation-cell-text" title={row.name}>{row.name}</span></td><td>{row.profile}</td><td>{row.workflow}</td>
        <td>{row.kind.replaceAll("_", " ")}</td><td>{row.version}</td><td><span className="evaluation-cell-text" title={row.dataset}>{row.dataset}</span></td>
        <td>{row.checks}</td><td>{row.location === "local" ? "Desktop" : "Hosted"}</td>
      </tr>)}<EvaluationTableState columns={8} loading={!rows.length && (loading || local.isPending || Boolean(api.projectId && associations.isPending))} empty={!rows.length}>No graders associated with this selection.</EvaluationTableState></tbody>
    </table></div>
  </>;
}
