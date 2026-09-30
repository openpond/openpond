import { WorkspaceResourceName, WorkspacePanelHost, WorkspacePanelControls, WorkspacePanelToolbar, useWorkspacePanelControls, useWorkspaceActions, type EvaluationSidebarControl } from "./WorkspacePanel";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClientConnection } from "../../../api/api-client";
import type { ModelsRoute } from "../models-route";
import { createWorkspaceApi, type Inventory } from "./workspace-api";
import { HostedExperimentsPage } from "./HostedExperimentsPage";
import { HostedDatasetsPage } from "./HostedDatasetsPage";
import { HostedGradersPage } from "./HostedGradersPage";
import { ProjectScopePicker } from "./ProjectScopePicker";
import { EvaluationSetupProvider, useEvaluationSetup } from "./EvaluationSetupState";
import { ExperimentSetupPanel } from "./ExperimentSetupPanel";
import "../../../styles/labs/evaluation-workspace.css";
function HostedEvaluationWorkspaceContent({ connection, teamId, accountKey, route, onNavigate, onLocalDatasets, onResourceName }: { connection: ClientConnection | null; teamId: string | null; accountKey: string; route: ModelsRoute; onNavigate: (route: ModelsRoute) => void; onLocalDatasets: () => void; onResourceName: (name: string | null) => void; onSidebarControl?: (control: EvaluationSidebarControl | null) => void }) {
  const panel = useWorkspacePanelControls();
  const setup = useEvaluationSetup();
  useWorkspaceActions(setup.draft ? [{ id: "experiment", label: "Experiment", onSelect: () => {} }] : []);
  const api = useMemo(() => connection && teamId ? createWorkspaceApi(connection, { teamId, accountKey, projectId: route.projectId ?? null }) : null, [connection, teamId, accountKey, route.projectId]);
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const restored = useRef<string | null>(null);
  useEffect(() => {
    const scope = `${accountKey}:${teamId}`;
    if (restored.current === scope) return; restored.current = scope;
    const remembered = localStorage.getItem(`openpond:evaluation-project:${scope}`);
    if (route.projectId === undefined && remembered) onNavigate({ ...route, projectId: remembered, resourceId: null, detailTab: null });
  }, [accountKey, teamId, route, onNavigate]);
  const inventory = useQuery({ queryKey: ["evaluation-workspace", api?.key, route.query, route.after, route.sort], enabled: Boolean(api), queryFn: ({ signal }) => api!.request<Inventory>("inventory", { ...(route.page === "datasets" ? { sort: route.sort ?? "name" } : {}), ...(route.query ? { search: route.query } : {}), ...(route.after ? route.page === "datasets" ? route.after.startsWith("catalog:") ? { catalogCursor: route.after.slice(8) } : { cursor: route.after.startsWith("workspace:") ? route.after.slice(10) : route.after } : { afterId: route.after } : {}) }, signal) });
  function changeProject(projectId: string | null) { localStorage.setItem(`openpond:evaluation-project:${accountKey}:${teamId}`, projectId ?? ""); onNavigate({ ...route, modelId: null, projectId, resourceId: null, detailTab: null, revision: undefined, contentHash: undefined, executionId: null, passId: null, after: null }); }
  if (!api) return <div className="labs-table-empty" role="status">Connect an OpenPond account and choose a workspace to open hosted datasets, graders and experiments.</div>;
  return <WorkspaceResourceName.Provider value={onResourceName}><WorkspacePanelHost.Provider value={panelHost}><section className="evaluation-workspace" data-panel-open={panel?.open} data-panel-side={panel?.side} style={{ "--evaluation-panel-width": `${panel?.width ?? 440}px` } as CSSProperties} aria-label="Hosted Models workspace"><div className="evaluation-workspace-main">
    <div className="evaluation-workspace-scope"><ProjectScopePicker key={api.key} api={api} page={inventory.data?.projects} selectedId={route.projectId ?? null} onChange={changeProject} /><button type="button" className="training-button secondary" aria-expanded={panel?.open} onClick={panel?.toggle}>{panel?.open ? "Hide sidebar" : "Open sidebar"}</button><small>Hosted · {inventory.data?.apiOrigin ?? "Connecting"}</small></div>
    {inventory.error ? <div role="alert"><p>{inventory.error.message}</p>{route.projectId ? <button className="training-button secondary" onClick={() => changeProject(null)}>Return to All projects</button> : <button className="training-button secondary" onClick={() => void inventory.refetch()}>Retry</button>}</div> : null}
    {inventory.isPending ? <p role="status">Loading workspace…</p> : null}
    {route.page === "graders" ? <HostedGradersPage key={`${api.key}:${route.resourceId ?? "collection"}`} api={api} route={route} navigate={onNavigate} /> : route.page === "datasets" ? <HostedDatasetsPage key={`${api.key}:${route.resourceId ?? "collection"}`} api={api} inventory={inventory.data ?? null} route={route} navigate={onNavigate} onLocalDatasets={onLocalDatasets} onRefresh={() => void inventory.refetch()} /> : <HostedExperimentsPage key={`${api.key}:${route.resourceId ?? "collection"}`} api={api} inventory={inventory.data ?? null} route={route} navigate={onNavigate} refresh={() => void inventory.refetch()} />}
    {setup.draft ? <ExperimentSetupPanel api={api} inventory={inventory.data ?? null} route={route} navigate={onNavigate} onSaved={value => { void inventory.refetch(); onNavigate({ ...route, page: "experiments", collection: "default", datasetKind: undefined, revision: undefined, contentHash: undefined, resourceId: value.id, detailTab: "configuration", executionId: null, passId: null }); }} /> : null}
  </div><aside className="evaluation-workspace-panel" aria-label="Details sidebar"><div className="evaluation-panel-resize" role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={800} aria-valuenow={panel?.width} onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); panel?.resize((panel?.width ?? 440) + (event.key === (panel?.side === "left" ? "ArrowRight" : "ArrowLeft") ? 24 : -24)); }} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = event.currentTarget.parentElement?.getBoundingClientRect(); if (rect) panel?.resize(panel?.side === "left" ? event.clientX - rect.left : rect.right - event.clientX); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} /><WorkspacePanelToolbar /><div ref={setPanelHost} /></aside></section></WorkspacePanelHost.Provider></WorkspaceResourceName.Provider>;
}

export function HostedEvaluationWorkspace(props: Parameters<typeof HostedEvaluationWorkspaceContent>[0]) { return <EvaluationSetupProvider key={JSON.stringify([props.accountKey, props.teamId, props.route.projectId ?? null])}><WorkspacePanelControls onControl={props.onSidebarControl}><HostedEvaluationWorkspaceContent {...props} /></WorkspacePanelControls></EvaluationSetupProvider>; }
