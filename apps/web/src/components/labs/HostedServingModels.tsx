import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostedModelProjectCatalog } from "../../hooks/hosted-model-project-types";
import type { useTraining } from "../../hooks/useTraining";
import { type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { HostedModelServingSetup } from "./HostedModelServingSetup";
import { createWorkspaceApi } from "./workspace/workspace-api";

const PAGE_SIZE = 20;

export function HostedServingModels({ connection, teamId, actorId, accountKey, modelProjectId, training }: {
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  accountKey: string;
  modelProjectId: string | null;
  training: ReturnType<typeof useTraining>;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const api = useMemo(() => createWorkspaceApi(connection, { teamId, actorId, accountKey, projectId: null }), [connection, teamId, actorId, accountKey]);
  const list = training.actions.listHostedModelProjects;
  const query = useQuery({
    queryKey: ["inference-models", connectionQueryScope(connection), accountKey, actorId, teamId],
    queryFn: async () => {
      const catalog = await list({ refresh: true, silent: true });
      if (!catalog) throw new Error("Could not load serving models. Retry the model list.");
      if (catalog.teamId !== teamId) throw new Error("The workspace changed. Reload serving models.");
      return catalog;
    },
    staleTime: 30_000,
    retry: false,
  });
  const rows = (query.data?.projects ?? []).filter(({ project }) =>
    project.teamId === teamId && (!modelProjectId || project.portableProjectId === modelProjectId)
    && (!search.trim() || `${project.name} ${project.objective}`.toLowerCase().includes(search.trim().toLowerCase())));
  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  return <section className="labs-operational-section" aria-label="Serving models">
    <ErrorToast error={query.error} />
    <header><div><h2>Your models</h2></div>
      <button type="button" className="training-button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isError ? "Retry models" : "Refresh models"}</button>
    </header>
    <label className="labs-search"><span>Search models</span><input type="search" value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0); }} placeholder="Search serving models" /></label>
    <div className="training-table-wrap"><table className="training-data-table">
      <thead><tr><th>Model</th><th>Starting model</th><th>Updated</th><th>Serving</th></tr></thead>
      <tbody>
        {query.isPending ? <tr><td colSpan={4}>Loading serving models…</td></tr> : null}
        {!query.isPending && !query.isError && !rows.length ? <tr><td colSpan={4}>{search ? "No models match this search." : "No saved models in this workspace yet."}</td></tr> : null}
        {visible.map(({ project }) => <HostedServingModelRow key={project.id} project={project} api={api} />)}
      </tbody>
    </table></div>
    {rows.length > PAGE_SIZE ? <div className="model-build-actions"><button className="training-button secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {lastPage + 1}</span><button className="training-button secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</button></div> : null}
  </section>;
}

function HostedServingModelRow({ project, api }: {
  project: HostedModelProjectCatalog["projects"][number]["project"];
  api: ReturnType<typeof createWorkspaceApi>;
}) {
  const [opened, setOpened] = useState(false);
  return <tr>
    <td><strong>{project.name}</strong>{project.objective ? <div className="training-muted">{project.objective}</div> : null}</td>
    <td>{project.trainingSetup.baseModel?.modelId ?? project.defaultBaseModel?.modelId ?? "—"}</td>
    <td>{new Date(project.updatedAt).toLocaleString()}</td>
    <td><button type="button" className="training-button" onClick={() => setOpened(true)}>Serve</button>
      {opened ? <HostedModelServingSetup key={`${api.key}:${project.id}`} api={api} modelId={project.id} name={project.name} onClose={() => setOpened(false)} /> : null}
    </td>
  </tr>;
}
