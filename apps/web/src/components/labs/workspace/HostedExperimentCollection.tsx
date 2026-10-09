import { ExperimentIdentity, useExperimentClock } from "./ExperimentIdentity";
import { ExperimentFeedbackCell, graderColumnKey } from "./ExperimentFeedbackCell";
import type { WorkspaceApi } from "./workspace-api";
import { useState } from "react";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import type { ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import { EvaluationModel, EvaluationStatus } from "./EvaluationPresentation";
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
  return (
    <>
      {selected ? (
        <button className="training-button" onClick={() => open(selected)}>
          Duplicate and edit
        </button>
      ) : null}
      <table className="training-data-table evaluation-workspace-table evaluation-history-table">
        <thead>
          <tr>
            <th>
              <span className="sr-only">Select Experiment</span>
            </th>
            <th>
              <span className="sr-only">Status</span>
            </th>
            <th>Experiment</th>
            <th>Target</th>
            <th>Dataset</th>
            <th>Model</th>
            <th>Tasks</th>
            {scoreColumns.map((grader) => (
              <th key={graderColumnKey(grader)}>
                {grader.name ?? "Grader"}
                <small>Mean score / this run</small>
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
                  aria-label={`Select ${item.request.name}`}
                  checked={selected?.summary.id === item.summary.id}
                  onChange={(event) => setSelected(event.target.checked ? item : null)}
                />
              </td>
              <td>
                <EvaluationStatus
                  iconOnly
                  status={
                    item.summary.status === "completed" && item.summary.counts.failed > 0
                      ? "failed"
                      : item.summary.status
                  }
                />
              </td>
              <td>
                <ExperimentIdentity
                  id={item.summary.id}
                  title={item.request.name}
                  createdAt={item.summary.createdAt}
                  startedAt={item.summary.startedAt}
                  completedAt={item.summary.completedAt}
                  now={now}
                  onOpen={() => navigate(destination(item))}
                />
              </td>
              <td
                title={
                  item.request.policy.kind === "hosted_harness"
                    ? item.request.policy.source.definitionId
                    : "Model"
                }
              >
                {item.request.policy.kind === "hosted_harness"
                  ? item.request.policy.source.definitionId
                  : "Model"}
              </td>
              <td title={item.request.taskset.id}>
                {item.request.taskset.id}
                <small>v{item.request.taskset.revision}</small>
              </td>
              <td>
                <EvaluationModel
                  name={"modelId" in item.request.policy ? item.request.policy.modelId : "Fixtures"}
                />
              </td>
              <td
                title={`${item.summary.counts.failed} failed / ${item.summary.counts.pending} pending`}
              >
                {item.summary.counts.completed}/{item.summary.totalCount}
              </td>
              {scoreColumns.map((grader) => (
                <td key={graderColumnKey(grader)}>
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
                  <details>
                    <summary>{item.summary.error.code?.replaceAll("_", " ") ?? "Failure"}</summary>
                    <p>{item.summary.error.message}</p>
                    <button
                      onClick={() => navigate({ ...destination(item), detailTab: "diagnostics" })}
                    >
                      Diagnostics
                    </button>
                  </details>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
          <EvaluationTableState
            columns={8 + scoreColumns.length}
            loading={loading}
            error={error}
            empty={!items.length}
            retry={retry}
          >
            Run an Experiment to evaluate selected Dataset tasks.
          </EvaluationTableState>
        </tbody>
      </table>
    </>
  );
}
