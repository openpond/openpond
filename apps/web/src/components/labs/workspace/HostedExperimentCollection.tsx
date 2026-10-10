import { ExperimentIdentity, experimentElapsed, useExperimentClock } from "./ExperimentIdentity";
import { ExperimentFeedbackCell, graderColumnKey } from "./ExperimentFeedbackCell";
import type { WorkspaceApi } from "./workspace-api";
import { useState } from "react";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import type { ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import { EvaluationModel, EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { ExperimentFailureCell } from "./ExperimentFailureCell";
import { EvaluationTableState } from "./EvaluationTableState";
export function HostedExperimentCollection({
  api,
  items,
  loading,
  error,
  retry,
  route,
  navigate,
}: {
  api: WorkspaceApi;
  items: ExperimentRunDetails[];
  loading: boolean;
  error?: string;
  retry: () => void;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
}) {
  const [selected, setSelected] = useState<ExperimentRunDetails | null>(null),
    setup = useEvaluationSetup(),
    controls = useWorkspacePanelControls();
  function open(item: ExperimentRunDetails) {
    setup.open({
      id: item.summary.id,
      request: item.request,
      graders: item.configuration.graders,
      maximumCostUsd: item.configuration.maximumCostUsd,
    });
    controls?.select({ id: "experiment", label: "Experiment", onSelect: () => {} });
  }
  const destination = (item: ExperimentRunDetails) => ({
    ...route,
    page: "experiments" as const,
    datasetKind: undefined,
    revision: undefined,
    contentHash: undefined,
    resourceId: item.summary.id,
    executionId: null,
    passId: null,
    detailTab: "tasks",
    after: null,
  });
  const now = useExperimentClock(
    items.some((item) => ["queued", "running", "cancelling"].includes(item.summary.status)),
  );
  const scoreColumns = [
    ...new Map(
      items
        .flatMap((item) => item.configuration.graders)
        .map((grader) => [graderColumnKey(grader), grader]),
    ).values(),
  ];
  const target = (item: ExperimentRunDetails) =>
    item.request.policy.kind === "hosted_harness"
      ? item.request.policy.source.target?.kind === "workflow"
        ? item.request.policy.source.target.workflowId
        : item.request.policy.source.definitionId
      : "Model only";
  return (
    <>
      {selected ? (
        <div className="evaluation-selection-bar" role="region" aria-label="Selected Experiment">
          <span>
            Selected <strong>{selected.request.name ?? selected.summary.id}</strong>
          </span>
          <button className="training-button" onClick={() => open(selected)}>
            Duplicate and edit
          </button>
          <button className="training-button secondary" onClick={() => setSelected(null)}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="evaluation-table-scroll evaluation-table-frame">
        <table
          className="training-data-table evaluation-workspace-table evaluation-history-table"
          style={{ minWidth: `${1160 + scoreColumns.length * 96}px` }}
        >
          <colgroup>
            <col className="evaluation-col-select" />
            <col className="evaluation-col-status" />
            <col className="evaluation-col-experiment" />
            <col className="evaluation-col-started" />
            <col className="evaluation-col-elapsed" />
            <col className="evaluation-col-target" />
            <col className="evaluation-col-dataset" />
            <col className="evaluation-col-model" />
            <col className="evaluation-col-tasks" />
            {scoreColumns.map((grader) => (
              <col key={graderColumnKey(grader)} className="evaluation-col-score" />
            ))}
            <col className="evaluation-col-errors" />
          </colgroup>
          <thead>
            <tr>
              <th>
                <span className="sr-only">Select Experiment</span>
              </th>
              <th className="evaluation-centered">
                <span className="sr-only">Status</span>
              </th>
              <th>Experiment</th>
              <th>Started</th>
              <th className="evaluation-numeric">Elapsed</th>
              <th>Target</th>
              <th>Dataset</th>
              <th>Model</th>
              <th className="evaluation-numeric">Tasks</th>
              {scoreColumns.map((grader) => (
                <th
                  key={graderColumnKey(grader)}
                  className="evaluation-numeric"
                  title={`${grader.name ?? "Grader"}: mean score for this run`}
                >
                  {grader.name ?? "Grader"}
                </th>
              ))}
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.summary.id}>
                <td>
                  <input
                    type="checkbox"
                    className="training-chat-checkbox"
                    aria-label={`Select ${item.request.name}`}
                    checked={selected?.summary.id === item.summary.id}
                    onChange={(event) => setSelected(event.target.checked ? item : null)}
                  />
                </td>
                <td className="evaluation-centered">
                  <EvaluationStatus
                    iconOnly
                    status={
                      item.summary.status === "completed" && item.summary.counts.failed > 0 ? "failed" : item.summary.status
                    }
                  />
                </td>
                <td>
                  <ExperimentIdentity
                    id={item.summary.id}
                    title={item.request.name}
                    onOpen={() => navigate(destination(item))}
                  />
                </td>
                <td className="evaluation-time-cell">
                  <EvaluationTime value={item.summary.startedAt ?? item.summary.createdAt} />
                </td>
                <td className="evaluation-numeric">
                  {experimentElapsed(item.summary.startedAt, item.summary.completedAt, now) ?? "—"}
                </td>
                <td>
                  <span className="evaluation-cell-text" title={target(item)}>
                    {target(item)}
                  </span>
                </td>
                <td>
                  <span className="evaluation-cell-text" title={item.request.taskset.id}>
                    {item.request.taskset.id}
                  </span>
                  <small>Version {item.request.taskset.revision}</small>
                </td>
                <td>
                  <EvaluationModel
                    name={"modelId" in item.request.policy ? item.request.policy.modelId : "Fixtures"}
                  />
                </td>
                <td
                  className="evaluation-numeric"
                  title={`${item.summary.counts.completed} completed, ${item.summary.counts.failed} failed, ${item.summary.counts.running} running, ${item.summary.counts.pending} pending`}
                >
                  {item.summary.counts.completed}/{item.summary.totalCount}
                </td>
                {scoreColumns.map((grader) => (
                  <td key={graderColumnKey(grader)} className="evaluation-numeric">
                    <ExperimentFeedbackCell
                      api={api}
                      id={item.summary.id}
                      manifestHash={item.summary.manifestHash}
                      available={item.summary.resultAvailable}
                      graders={item.configuration.graders}
                      grader={grader}
                    />
                  </td>
                ))}
                <td>
                  {item.summary.error ? (
                    <ExperimentFailureCell
                      label={item.summary.error.code?.replaceAll("_", " ") ?? "Failure"}
                      message={item.summary.error.message}
                      onDiagnostics={() => navigate({ ...destination(item), detailTab: "diagnostics" })}
                    />
                  ) : (
                    <span className="evaluation-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            <EvaluationTableState
              columns={10 + scoreColumns.length}
              loading={loading}
              error={error}
              empty={!items.length}
              retry={retry}
            >
              Run an Experiment to evaluate selected Dataset tasks.
            </EvaluationTableState>
          </tbody>
        </table>
      </div>
    </>
  );
}
