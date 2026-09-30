import { EvaluationModel, EvaluationStatus, EvaluationTime, evaluationRelativeTime } from "./EvaluationPresentation";
import { ExperimentHistory } from "./ExperimentHistory";
import { ExperimentCompare } from "./ExperimentCompare";
import { useWorkspaceActions, useWorkspaceResourceName } from "./WorkspacePanel";
import { useRef, useState } from "react";
import { experimentDefinitionRef } from "openpond-sdk/experiments";
import type { ModelTasksetRunDetails } from "openpond-sdk/model-taskset-runs";
import type { ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { ExperimentCases } from "./ExperimentCases";
import { ExperimentConfiguration } from "./ExperimentConfiguration";
import { ScoringPassStatus } from "./ScoringPassStatus";
import { useHostedExperimentDetail } from "./useHostedExperimentDetail";
import type { Inventory, WorkspaceApi } from "./workspace-api";
export function HostedExperimentsPage({ api, inventory, route, navigate, refresh }: { api: WorkspaceApi; inventory: Inventory | null; route: ModelsRoute; navigate: (route: ModelsRoute) => void; refresh: () => void }) {
  const setup = useEvaluationSetup();
  const [busy, setBusy] = useState(false);
  const activeMutation = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const detail = useHostedExperimentDetail(api, route);
  const { definition, history, execution, executionId, executionItems, passes, passItems, selectedPass, evidence, executedRef, executedDefinition, retainedDefinition } = detail;
  async function mutate(action: () => Promise<void>) {
    if (activeMutation.current) return; activeMutation.current = true; setBusy(true); setError(null);
    try { await action(); await detail.refresh(); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { activeMutation.current = false; setBusy(false); }
  }
  function start() { const saved = definition.data; if (!saved) return; void mutate(async () => { const operation = api.operation("start", experimentDefinitionRef(saved)); const run = await api.request<ModelTasksetRunDetails>("start", { operationId: operation.id, definition: experimentDefinitionRef(saved) }); navigate({ ...route, executionId: run.summary.id, passId: null, detailTab: "cases" }); }); }
  function rerun() { if (!executionId) return; void mutate(async () => { const operation = api.operation("retry", { executionId }); const run = await api.request<ModelTasksetRunDetails>("retry", { id: executionId, operationId: operation.id }); operation.acknowledge(); navigate({ ...route, executionId: run.summary.id, passId: null, detailTab: "cases" }); }); }
  const selectSidebarAction = useWorkspaceActions(!route.resourceId || definition.data ? [{ id: "experiment", label: "Experiment", onSelect: () => setup.open(definition.data ?? null, null, null, inventory?.projects.projects.find(project => project.id === api.projectId)?.content.defaultTargetId ?? "model") }] : []);
  const saved = definition.data;
  const run = execution.data;
  const displayed = retainedDefinition ?? saved;
  const tab = route.detailTab ?? "overview";
  const target = executionId ? run?.request.policy : saved?.request.policy;
  const model = target && "modelId" in target ? target.modelId : null;
  useWorkspaceResourceName(saved?.request.name ?? retainedDefinition?.request.name ?? (definition.error ? "Unavailable experiment" : null));
  return <><header className="evaluation-workspace-header"><h1>{saved?.request.name ?? retainedDefinition?.request.name ?? "Experiments"}</h1>{saved ? <><button className="training-button secondary" disabled={busy} onClick={() => selectSidebarAction("experiment")}>Edit setup</button><button className="training-button" disabled={busy} onClick={start}>Start</button></> : !route.resourceId ? <button className="training-button" onClick={() => selectSidebarAction("experiment")}>+ Experiment</button> : null}</header>
    {!route.resourceId ? <nav className="evaluation-workspace-tabs" aria-label="Experiment collection tabs">{["default", "history"].map(collection => <button key={collection} aria-selected={route.collection === collection} onClick={() => navigate({ ...route, collection: collection as "default" | "history", after: null, query: "" })}>{collection === "default" ? "Experiments" : "History"}</button>)}</nav> : null}
    {error || definition.error || history.error || execution.error || passes.error || selectedPass.error || evidence.error || executedDefinition.error ? <p role="alert">{error ?? definition.error?.message ?? history.error?.message ?? execution.error?.message ?? passes.error?.message ?? selectedPass.error?.message ?? evidence.error?.message ?? executedDefinition.error?.message}</p> : null}
    {!route.resourceId && route.collection === "history" ? <ExperimentHistory api={api} route={route} navigate={navigate} /> : displayed ? <><p>{target?.kind === "hosted_harness" ? `${target.source.target.kind} · ${target.source.definitionId}` : target?.kind === "fixture" ? "Authored fixtures" : target ? "Model" : "Loading selected target…"}{model ? <> · <EvaluationModel name={model} onOpen={() => navigate({ ...route, detailTab: "configuration" })} /></> : ""} · Setup revision {executionId ? executedRef?.revision ?? "Loading…" : saved?.revision}</p>
      <nav className="evaluation-workspace-tabs" aria-label="Experiment tabs">{["overview", "cases", "compare", "configuration"].map(value => <button key={value} aria-selected={tab === value} onClick={() => navigate({ ...route, detailTab: value })}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
      <div className="evaluation-workspace-scope"><label>Execution <select value={executionId ?? ""} onChange={event => navigate({ ...route, executionId: event.target.value, passId: null })}><option value="">Choose execution</option>{executionItems.map(item => <option key={item.summary.id} value={item.summary.id}>{evaluationRelativeTime(item.summary.createdAt)} · {item.summary.status} · {item.summary.id}</option>)}</select></label>{run ? <span>Started <EvaluationTime value={run.summary.startedAt ?? run.summary.createdAt} /></span> : null}{run ? <button className="training-button secondary" disabled={busy} onClick={rerun}>Run again</button> : null}{run && ["queued", "running", "cancelling"].includes(run.summary.status) ? <button className="training-button secondary" disabled={busy || run.summary.status === "cancelling"} onClick={() => void mutate(async () => { await api.request("cancel", { id: executionId }); })}>Cancel</button> : null}</div>
      {run ? <p><EvaluationStatus status={run.summary.status} /> · {run.summary.counts.completed}/{run.summary.totalCount} completed · {run.summary.cleanupComplete ? "Cleanup complete" : "Cleanup pending"}{run.summary.error ? ` · ${run.summary.error.message}` : ""}</p> : null}
      {passItems.length ? <label>Scoring <select value={route.passId ?? ""} onChange={event => navigate({ ...route, executionId, passId: event.target.value || null })}><option value="">Original execution grading</option>{passItems.map(pass => <option value={pass.id} key={pass.id}>{pass.id} · {pass.status}</option>)}</select></label> : null}
      {selectedPass.data ? <ScoringPassStatus pass={selectedPass.data} busy={busy} onCancel={() => void mutate(async () => { await api.request("cancelPass", { id: selectedPass.data.id }); })} /> : null}
      {history.hasNextPage ? <button className="training-button secondary" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Older executions</button> : null}
      {passes.hasNextPage ? <button className="training-button secondary" disabled={passes.isFetchingNextPage} onClick={() => void passes.fetchNextPage()}>Older scoring passes</button> : null}
      {tab === "configuration" && executionId && !run ? <p role="status">Loading selected execution configuration…</p> : tab === "configuration" ? <ExperimentConfiguration saved={saved ?? null} execution={run ?? null} executedRef={executedRef} retained={retainedDefinition ?? null} pass={selectedPass.data ?? null} /> : null}
      {tab === "compare" ? <ExperimentCompare key={`${executionId}:${route.passId ?? "original"}`} api={api} inventory={inventory} definitionId={displayed.id} baselineId={route.passId ?? executionId} /> : null}
      {evidence.data && retainedDefinition ? <div hidden={tab === "configuration" || tab === "compare"}><ExperimentCases key={`${executionId}:${route.passId ?? "original"}`} evidence={evidence.data} api={api} execution={run ?? null} saved={retainedDefinition} busy={busy} onScore={action => void mutate(action)} onSelectPass={passId => navigate({ ...route, executionId, passId, detailTab: "cases" })} /></div> : tab !== "configuration" && tab !== "compare" ? <p role="status">{run ? "Waiting for retained case results…" : "Save setup, then Start to create an execution."}</p> : null}
    </> : route.resourceId ? <p role="status">{definition.isPending || execution.isPending || executedDefinition.isFetching ? "Loading Experiment…" : "This Experiment is unavailable in the selected workspace."}</p> : <><label>Search experiments <input value={route.query} onChange={event => navigate({ ...route, query: event.target.value, after: null })} /></label><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Experiment</th><th>Target</th><th>Dataset</th><th>Revision</th></tr></thead><tbody>{inventory?.experiments.items.map(item => <tr key={item.id} tabIndex={0} onClick={() => navigate({ ...route, resourceId: item.id, detailTab: "overview" })} onKeyDown={event => { if (event.key === "Enter") navigate({ ...route, resourceId: item.id, detailTab: "overview" }); }}><td>{item.request.name}</td><td><EvaluationModel name={"modelId" in item.request.policy ? item.request.policy.modelId : "Fixture"} onOpen={() => navigate({ ...route, resourceId: item.id, detailTab: "configuration" })} /></td><td>{item.request.taskset.id}</td><td>{item.revision}</td></tr>)}</tbody></table>{inventory?.experiments.nextCursor ? <button onClick={() => navigate({ ...route, after: inventory.experiments.nextCursor })}>More experiments</button> : null}{inventory && !inventory.experiments.items.length ? <p>No experiments in this Project.</p> : null}</>}
  </>;
}
