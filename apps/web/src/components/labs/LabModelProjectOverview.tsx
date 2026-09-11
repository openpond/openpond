import type { ReactNode } from "react";
import type { ModelProject, TrainingStateResponse } from "@openpond/contracts";
import { formatDateTime } from "../training/training-model-data";
import type { LabModelVersion } from "./lab-models";
import { LabContinualLearningSeries } from "./LabContinualLearningSeries";
import { LabRunStatusBadge } from "./LabRunStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { LabProjectMetricCharts } from "./LabProjectMetricCharts";
import { modelProjectTasksetIds } from "./models-resource-scope";
import { modelsLocation, navigateModelsRoute } from "./lab-primary-tab-state";
import type { ModelOverviewRun } from "./model-overview-runs";

export function LabModelProjectOverview({ actions, modelProject, modelRuns, onOpenRun, onOpenSeries, state, status, versions }: {
  actions?: ReactNode; modelProject: ModelProject | null; modelRuns: ModelOverviewRun[]; onOpenRun: (runId: string) => void;
  onOpenSeries: (seriesId: string) => void; state: TrainingStateResponse | null; status?: ReactNode; versions: LabModelVersion[];
}) {
  const orderedRuns = [...modelRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const currentVersion = versions.find(version => version.current) ?? null;
  const trainingModel = modelProject?.trainingSetup.baseModel ?? modelProject?.defaultBaseModel;
  const tasksetIds = modelProjectTasksetIds(modelProject);
  const tasksets = state?.tasksets.filter(taskset => tasksetIds.has(taskset.id)) ?? [];
  const open = (page: "tasks" | "versions" | "serving", resourceId: string | null = null) => { void navigateModelsRoute(modelsLocation(page, modelProject?.id ?? null, { resourceId })); };
  return <div className="labs-model-overview">
    <ModelProjectPageHeader actions={actions} description={modelProject?.objective ?? ""} status={status} title={modelProject?.name ?? "Model"} />
    <section><h2>Configuration</h2><div className="training-table-wrap"><table className="training-data-table"><tbody><tr><th scope="row">Starting model</th><td>{trainingModel?.modelId ?? "Choose a model"}</td></tr><tr><th scope="row">Training method</th><td>{modelProject?.trainingSetup.method?.toUpperCase() ?? "Not configured"}</td></tr><tr><th scope="row">Current version</th><td>{currentVersion ? `Version ${currentVersion.number}` : "Base only"}</td></tr></tbody></table></div></section>
    <section><h2>Tasks</h2><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Collection</th><th>Revision</th><th>Tasks</th></tr></thead><tbody>{tasksets.map(taskset => <tr key={taskset.id}><td><button type="button" className="labs-version-row-button" onClick={() => open("tasks", taskset.id)}>{taskset.name}</button></td><td>{taskset.revision}</td><td>{taskset.datasetArtifact?.rowCount ?? taskset.tasks.length}</td></tr>)}{!tasksets.length ? <tr><td colSpan={3}>No task collections attached.</td></tr> : null}</tbody></table></div></section>
    <section><h2>Versions</h2><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Version</th><th>Status</th></tr></thead><tbody>{versions.map(version => <tr key={version.lineage.id}><td><button type="button" className="labs-version-row-button" onClick={() => open("versions", `version:${version.lineage.id}`)}>Version {version.number}</button></td><td>{version.current ? "Current" : version.lineage.promotable ? "Ready" : "Retained"}</td></tr>)}{!versions.length ? <tr><td colSpan={2}>No trained versions yet.</td></tr> : null}</tbody></table></div></section>
    <section><h2>Recent runs</h2><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Run</th><th>Status</th><th>Updated</th></tr></thead><tbody>{orderedRuns.slice(0, 10).map(run => <tr key={run.key}><td><button type="button" className="labs-version-row-button" onClick={() => onOpenRun(run.key)}>{run.label}</button></td><td><LabRunStatusBadge status={run.status} /></td><td>{formatDateTime(run.updatedAt)}</td></tr>)}{!orderedRuns.length ? <tr><td colSpan={3}>No runs yet.</td></tr> : null}</tbody></table></div></section>
    <section><h2>Serving</h2><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Version</th><th>Status</th></tr></thead><tbody><tr><td>{currentVersion ? `Version ${currentVersion.number}` : "None"}</td><td><button type="button" className="labs-version-row-button" onClick={() => open("serving")}>{currentVersion?.lineage.managedServing?.customerBindingAllowed ? "Ready to serve" : "Not serving"}</button></td></tr></tbody></table></div></section>
    <details><summary>Metrics and comparison series</summary><LabProjectMetricCharts runs={modelRuns} /><LabContinualLearningSeries modelProjectId={modelProject?.id ?? null} onOpenRun={runId => onOpenRun(`model-run:${runId}`)} onOpenSeries={onOpenSeries} state={state} /></details>
  </div>;
}
