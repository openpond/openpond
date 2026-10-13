import { DropdownSelect } from "../../DropdownSelect";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EvaluationCard } from "./EvaluationPresentation";
import { EvaluationTableState } from "./EvaluationTableState";
import { useWorkspaceResourceName, useWorkspaceActions, useWorkspacePanelControls, WorkspacePanel } from "./WorkspacePanel";
import { useLocalLearningCatalog, profileDisplayName, LocalDatasetMetadataSchema, localMetadataGraders } from "./local-learning-catalog";
import { UnifiedExperimentCollection } from "./UnifiedExperimentCollection";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function LocalSavedDatasetPage({ api, route, navigate }: { api: WorkspaceApi; route: ModelsRoute; navigate: (value: ModelsRoute) => void }) {
  const catalog = useLocalLearningCatalog(api);
  const query = useQuery({ queryKey: ["local-dataset-metadata", api.key, route.resourceId, route.revision],
    queryFn: async ({ signal }) => LocalDatasetMetadataSchema.parse(await api.localDatasets("read", { view: "metadata", ...(route.revision ? { revision: route.revision } : {}) }, route.resourceId!, signal)),
  });
  const controls = useWorkspacePanelControls();
  const [taskId, setTaskId] = useState<string | null>(null);
  const dataset = catalog.data?.find(row => row.summary.id === route.resourceId);
  const record = query.data?.record, draft = record?.workspace.draft;
  const task = draft?.tasks.find(task => task.id === taskId);
  useWorkspaceActions(task ? [{ id: "task", label: "Task", onSelect: () => {} }] : []);
  useWorkspaceResourceName(draft?.name ?? null);
  if (query.isPending) return <p role="status">Loading saved Dataset…</p>;
  if (query.error) return <p role="alert">{query.error.message} <button className="training-text-button" onClick={() => void query.refetch()}>Retry</button></p>;
  if (!record || !draft) return <p role="alert">This saved Dataset is unavailable.</p>;
  const tab = route.detailTab ?? "tasks";
  const graders = localMetadataGraders(record);
  return <>
    <header className="evaluation-workspace-header"><h1>{draft.name}</h1></header>
    <p className="evaluation-meta-line">{profileDisplayName(dataset?.profileTarget?.profileId)} · {dataset?.profileTarget?.workflowId ?? "No workflow binding"} · Revision {draft.revision} · Desktop</p>
    <nav className="evaluation-workspace-tabs" aria-label="Dataset sections">{["tasks", "graders", "experiments", "versions"].map(value =>
      <button key={value} aria-selected={tab === value} onClick={() => { setTaskId(null); navigate({ ...route, detailTab: value }); }}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
    {tab === "tasks" ? <div className="evaluation-table-scroll evaluation-table-frame"><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Task</th><th>Input</th><th>Split</th></tr></thead><tbody>
      {draft.tasks.map(task => <tr key={task.id}><td><button className="training-text-button" onClick={() => { setTaskId(task.id); controls?.select({ id: "task", label: "Task", onSelect: () => {} }); }}>{task.id}</button></td>
        <td><code className="evaluation-cell-text evaluation-task-input">{JSON.stringify(task.input).slice(0, 200)}</code></td><td>{task.split}</td></tr>)}
      <EvaluationTableState columns={3} empty={!draft.tasks.length}>This Dataset has no saved tasks.</EvaluationTableState></tbody></table></div>
      : tab === "graders" ? <div className="evaluation-table-scroll evaluation-table-frame"><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Grader</th><th>Type</th><th>Version</th><th>Checks</th></tr></thead><tbody>
        {graders.map(grader => <tr key={grader.id}><td><button className="training-text-button" onClick={() => navigate({ ...route, page: "graders", resourceId: grader.id,
          revision: draft.revision, contentHash: grader.configurationHash, detailTab: "overview", executionLocation: "local" })}>{grader.name}</button></td>
          <td>{grader.kind.replaceAll("_", " ")}</td><td>{grader.version}</td><td>{grader.checkState}</td></tr>)}
        <EvaluationTableState columns={4} empty={!graders.length}>This Dataset has no saved graders.</EvaluationTableState></tbody></table></div>
      : tab === "experiments" ? <UnifiedExperimentCollection api={api} route={route} navigate={navigate} datasetId={draft.id} />
      : <><DropdownSelect label="Dataset revision" value={String(draft.revision)} searchable={(dataset?.summary.revision ?? draft.revision) > 8}
        options={Array.from({length:dataset?.summary.revision ?? draft.revision},(_,index)=>({value:String(index+1),label:`Revision ${index+1}`})).reverse()}
        onChange={value=>navigate({...route,revision:Number(value),contentHash:undefined})} /><EvaluationCard title="Saved Dataset"><dl className="evaluation-workspace-meta"><dt>Revision</dt><dd>{draft.revision}</dd><dt>Workspace hash</dt><dd>{record.workspace.contentHash}</dd>
        <dt>Tasks</dt><dd>{query.data!.summary.taskCount}</dd><dt>Environment</dt><dd>{draft.environment.kind}</dd><dt>Objective</dt><dd>{draft.objective}</dd>
        <dt>Checks</dt><dd>{query.data!.summary.checkState}</dd></dl></EvaluationCard></>}
    {task ? <WorkspacePanel action="task" label="Task inspector" onRequestClose={() => setTaskId(null)}><header><h2>{task.id}</h2></header>
      <EvaluationCard title="Input"><pre>{JSON.stringify(task.input, null, 2)}</pre></EvaluationCard>
      <EvaluationCard title="Policy context"><pre>{JSON.stringify(task.policyVisibleContext, null, 2)}</pre></EvaluationCard></WorkspacePanel> : null}
  </>;
}
