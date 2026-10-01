import { ExperimentFeedbackCell, graderColumnKey } from "./ExperimentFeedbackCell";
import type { WorkspaceApi } from "./workspace-api";
import { useState } from "react";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import type { ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import { EvaluationModel, EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
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
    detailTab: "overview",
    after: null,
  });
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
      <table className="training-data-table evaluation-workspace-table">
        <thead>
          <tr>
            <th>
              <span className="sr-only">Select Experiment</span>
            </th>
            <th>Experiment</th>
            <th>Graders</th>
            <th>Target</th>
            <th>Dataset</th>
            <th>Status</th>
            <th>Cases</th>
            <th>Started</th>
            {scoreColumns.map((grader) => (
              <th key={graderColumnKey(grader)}>
                {grader.name ?? "Grader"}
                <small>Mean score · this run</small>
              </th>
            ))}
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
                <button
                  className="training-text-button"
                  onClick={() => navigate(destination(item))}
                >
                  {item.request.name}
                </button>
              </td>
              <td>
                <div className="evaluation-grader-badges">
                  {item.configuration.graders.map((grader) =>
                    grader.release ? (
                      <button
                        key={grader.id}
                        className="evaluation-model-badge"
                        onClick={() =>
                          navigate({
                            ...route,
                            page: "graders",
                            resourceId: grader.release!.id,
                            detailTab: "overview",
                            executionId: null,
                            passId: null,
                            after: null,
                          })
                        }
                      >
                        {grader.name ?? "Grader name unavailable"}
                      </button>
                    ) : (
                      <span key={grader.id} className="evaluation-model-badge">
                        {grader.name ?? "Dataset grader"}
                      </span>
                    ),
                  )}
                </div>
              </td>
              <td>
                <EvaluationModel
                  name={
                    "modelId" in item.request.policy
                      ? item.request.policy.modelId
                      : "Authored fixtures"
                  }
                  onOpen={() => navigate({ ...destination(item), detailTab: "configuration" })}
                />
              </td>
              <td>Version {item.request.taskset.revision}</td>
              <td>
                <EvaluationStatus status={item.summary.status} />
              </td>
              <td>
                {item.summary.counts.completed} completed · {item.summary.counts.failed} failed /{" "}
                {item.summary.totalCount}
              </td>
              <td>
                <EvaluationTime value={item.summary.startedAt ?? item.summary.createdAt} />
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
