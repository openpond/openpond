import { useState } from "react";
import { ExperimentIdentity, experimentElapsed, useExperimentClock } from "./ExperimentIdentity";
import { HostedExperimentCost, LocalExperimentCost } from "./ExperimentCost";
import { ExperimentFeedbackCell, graderColumnKey } from "./ExperimentFeedbackCell";
import { EvaluationModel, EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { EvaluationTableState } from "./EvaluationTableState";
import { ExperimentFailureCell } from "./ExperimentFailureCell";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import { profileDisplayName } from "./local-learning-catalog";
import type { ExperimentCollectionRecord } from "./experiment-collection-record";
import type { ModelsRoute } from "../models-route";

export function ExperimentCollectionTable({ rows, loading, route, navigate }: {
  rows: ExperimentCollectionRecord[]; loading: boolean; route: ModelsRoute; navigate: (route: ModelsRoute) => void;
}) {
  const [selected, setSelected] = useState<ExperimentCollectionRecord | null>(null);
  const setup = useEvaluationSetup(), controls = useWorkspacePanelControls();
  const now = useExperimentClock(rows.some(row => ["queued", "running", "cancelling"].includes(row.status)));
  const columns = [...new Map(rows.flatMap(row => row.graders).map(grader => [graderColumnKey(grader), grader])).values()];
  const open = (row: ExperimentCollectionRecord, detailTab = "tasks") => navigate({ ...route, page: "experiments",
    executionLocation: row.location, resourceId: row.id, detailTab, collection: "default", datasetKind: undefined,
    revision: undefined, contentHash: undefined, executionId: null, passId: null, after: null });
  function duplicate(row: ExperimentCollectionRecord) {
    setup.open({ id: row.id, request: row.request, graders: row.graders, maximumCostUsd: row.maximumCostUsd,
      ...(row.packageHash ? { packageHash: row.packageHash } : {}) }, null, { ...route, executionLocation: row.location });
    controls?.select({ id: "experiment", label: "Experiment", onSelect: () => {} });
  }
  return <>
    {selected ? <div className="evaluation-selection-bar" role="region" aria-label="Selected Experiment">
      <span>Selected <strong>{selected.request.name ?? selected.id}</strong></span>
      <button className="training-button" onClick={() => duplicate(selected)}>Duplicate and edit</button>
      <button className="training-button secondary" onClick={() => setSelected(null)}>Clear</button>
    </div> : null}
    <div className="evaluation-table-scroll evaluation-table-frame">
      <table className="training-data-table evaluation-workspace-table evaluation-history-table" style={{ minWidth: `${1508 + columns.length * 96}px` }}>
        <colgroup><col className="evaluation-col-select" /><col className="evaluation-col-status" /><col className="evaluation-col-cost" />
          <col className="evaluation-col-experiment" /><col className="evaluation-col-profile" /><col className="evaluation-col-workflow" />
          <col className="evaluation-col-model" /><col className="evaluation-col-started" /><col className="evaluation-col-elapsed" />
          <col className="evaluation-col-origin" /><col className="evaluation-col-dataset" /><col className="evaluation-col-tasks" />
          {columns.map(grader => <col key={graderColumnKey(grader)} className="evaluation-col-score" />)}<col className="evaluation-col-errors" />
        </colgroup>
        <thead><tr><th><span className="sr-only">Select Experiment</span></th><th><span className="sr-only">Status</span></th>
          <th className="evaluation-numeric">Cost / usage</th><th>Experiment</th><th>Profile</th><th>Workflow</th><th>Model</th>
          <th>Started</th><th className="evaluation-numeric">Elapsed</th><th>Location</th><th>Dataset</th><th className="evaluation-numeric">Tasks</th>
          {columns.map(grader => <th className="evaluation-numeric" key={graderColumnKey(grader)} title={`${grader.name ?? grader.id}: mean score`}>{grader.name ?? grader.id}</th>)}<th>Errors</th>
        </tr></thead>
        <tbody>{rows.map(row => {
          const source = row.request.policy.kind === "hosted_harness" ? row.request.policy.source : null;
          return <tr key={row.key} tabIndex={0} onClick={() => open(row)} onKeyDown={event => { if (event.key === "Enter" && event.target === event.currentTarget) open(row); }}>
            <td><input type="checkbox" className="training-chat-checkbox" aria-label={`Select ${row.request.name}`} checked={selected?.key === row.key}
              onClick={event => event.stopPropagation()} onChange={event => setSelected(event.target.checked ? row : null)} /></td>
            <td className="evaluation-centered"><EvaluationStatus iconOnly status={row.status} /></td>
            <td className="evaluation-numeric">{row.raw.location === "local" ? <LocalExperimentCost api={row.api} run={row.raw.value} /> : <HostedExperimentCost api={row.api} run={row.raw.value} />}</td>
            <td><ExperimentIdentity id={row.id} title={row.request.name} onOpen={() => open(row)} /></td>
            <td><span className="evaluation-cell-text" title={source?.profileId}>{profileDisplayName(source?.profileId)}</span></td>
            <td><span className="evaluation-cell-text">{source?.target?.kind === "workflow" ? source.target.workflowId : "—"}</span></td>
            <td><EvaluationModel name={row.modelId} /></td><td className="evaluation-time-cell"><EvaluationTime value={row.startedAt ?? row.createdAt} /></td>
            <td className="evaluation-numeric">{experimentElapsed(row.startedAt ?? row.createdAt, row.completedAt, now) ?? "—"}</td>
            <td><span className="evaluation-muted">{row.location === "local" ? "Desktop" : "Hosted"}</span></td>
            <td><span className="evaluation-cell-text" title={row.request.taskset.id}>{row.request.taskset.id}</span><small>Version {row.request.taskset.revision}</small></td>
            <td className="evaluation-numeric">{row.completed}/{row.total}</td>
            {columns.map(grader => <td className="evaluation-numeric" key={graderColumnKey(grader)}><ExperimentFeedbackCell api={row.api} id={row.id}
              manifestHash={row.manifestHash} available={row.resultAvailable} graders={row.graders} grader={grader} /></td>)}
            <td>{row.error ? <ExperimentFailureCell label={row.error} onDiagnostics={() => open(row, "diagnostics")} /> : <span className="evaluation-muted">—</span>}</td>
          </tr>;
        })}<EvaluationTableState columns={13 + columns.length} loading={loading} empty={!rows.length}>Run an Experiment to evaluate selected Dataset tasks.</EvaluationTableState></tbody>
      </table>
    </div>
  </>;
}
