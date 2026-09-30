import { WorkspacePanelHost } from "./WorkspacePanel";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClientConnection } from "../../../api/api-client";
import type { ModelsRoute } from "../models-route";
import { createWorkspaceApi, type Inventory } from "./workspace-api";
import { HostedExperimentsPage } from "./HostedExperimentsPage";
import { HostedDatasetsPage } from "./HostedDatasetsPage";
import { HostedGradersPage } from "./HostedGradersPage";
import "../../../styles/labs/evaluation-workspace.css";
export function HostedEvaluationWorkspace({ connection, teamId, accountKey, route, onNavigate, onLocalDatasets }: { connection: ClientConnection | null; teamId: string | null; accountKey: string; route: ModelsRoute; onNavigate: (route: ModelsRoute) => void; onLocalDatasets: () => void }) {
  const api = useMemo(() => connection && teamId ? createWorkspaceApi(connection, { teamId, accountKey, projectId: route.projectId ?? null }) : null, [connection, teamId, accountKey, route.projectId]);
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const restored = useRef<string | null>(null);
  useEffect(() => {
    const scope = `${accountKey}:${teamId}`;
    if (restored.current === scope) return; restored.current = scope;
    const remembered = localStorage.getItem(`openpond:evaluation-project:${scope}`);
    if (route.projectId === undefined && remembered) onNavigate({ ...route, projectId: remembered, resourceId: null, detailTab: null });
  }, [accountKey, teamId, route, onNavigate]);
  const inventory = useQuery({ queryKey: ["evaluation-workspace", api?.key, route.query, route.after], enabled: Boolean(api), queryFn: ({ signal }) => api!.request<Inventory>("inventory", { ...(route.query ? { search: route.query } : {}), ...(route.after ? { afterId: route.after } : {}) }, signal) });
  function changeProject(projectId: string | null) { localStorage.setItem(`openpond:evaluation-project:${accountKey}:${teamId}`, projectId ?? ""); onNavigate({ ...route, modelId: null, projectId, resourceId: null, detailTab: null, executionId: null, passId: null, after: null }); }
  if (!api) return <div className="labs-table-empty" role="status">Connect an OpenPond account and choose a workspace to open hosted datasets, graders and experiments.</div>;
  return <WorkspacePanelHost.Provider value={panelHost}><section className="evaluation-workspace" aria-label="Hosted Models workspace"><div className="evaluation-workspace-main">
    <div className="evaluation-workspace-scope"><label htmlFor="evaluation-project">Project</label><select id="evaluation-project" value={route.projectId ?? ""} onChange={event => changeProject(event.target.value || null)}><option value="">All projects</option>{route.projectId && !inventory.data?.projects.projects.some(project => project.id === route.projectId) ? <option value={route.projectId}>Unavailable Project</option> : null}{inventory.data?.projects.projects.filter(project => !project.archived).map(project => <option key={project.id} value={project.id}>{project.content.name}</option>)}</select><small>Hosted · {inventory.data?.apiOrigin ?? "Connecting"}</small></div>
    {inventory.error ? <div role="alert"><p>{inventory.error.message}</p>{route.projectId ? <button className="training-button secondary" onClick={() => changeProject(null)}>Return to All projects</button> : <button className="training-button secondary" onClick={() => void inventory.refetch()}>Retry</button>}</div> : null}
    {inventory.isPending ? <p role="status">Loading workspace…</p> : null}
    {route.page === "graders" ? <HostedGradersPage key={api.key} api={api} route={route} navigate={onNavigate} /> : route.page === "datasets" ? <HostedDatasetsPage key={api.key} api={api} inventory={inventory.data ?? null} route={route} navigate={onNavigate} onLocalDatasets={onLocalDatasets} onRefresh={() => void inventory.refetch()} /> : <HostedExperimentsPage key={api.key} api={api} inventory={inventory.data ?? null} route={route} navigate={onNavigate} refresh={() => void inventory.refetch()} />}
  </div><aside className="evaluation-workspace-panel"><div ref={setPanelHost} /></aside></section></WorkspacePanelHost.Provider>;
}
