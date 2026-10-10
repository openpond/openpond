import { ExperimentIdentity, experimentElapsed, useExperimentClock } from "./ExperimentIdentity";
import { useState } from "react";
import type { z } from "zod";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import type { LocalExperimentRecord } from "@openpond/contracts";
import { ExperimentFeedbackCell, graderColumnKey } from "./ExperimentFeedbackCell";
import { EvaluationTableState } from "./EvaluationTableState";
import { useQuery } from "@tanstack/react-query";
import { LocalExperimentRecordPageSchema } from "@openpond/contracts";
import { EvaluationModel, EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { ExperimentFailureCell } from "./ExperimentFailureCell";
import { localRequest } from "./local-workspace-api";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function LocalExperimentCollection({
  api,
  route,
  navigate,
  datasetHash,
}: {
  datasetHash?: string;
  api: WorkspaceApi;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
}) {
  const [selected, setSelected] = useState<LocalExperimentRecord | null>(null),
    setup = useEvaluationSetup(),
    controls = useWorkspacePanelControls();
  function duplicate(item: LocalExperimentRecord) {
    setup.open({
      id: item.id,
      request: item.configuration.request,
      graders: item.graders,
      maximumCostUsd: item.configuration.maximumCostUsd,
      packageHash: item.packageHash,
    });
    controls?.select({ id: "experiment", label: "Experiment", onSelect: () => {} });
  }
  const query = {
    ...(api.projectId ? { projectId: api.projectId } : {}),
    ...(datasetHash ? { datasetHash } : {}),
    ...(route.query ? { search: route.query } : {}),
    ...(route.after ? { afterId: route.after } : {}),
  };
  const definitions = useQuery<z.output<typeof LocalExperimentRecordPageSchema>>({
    queryKey: ["local-experiments", api.key, "list", route.after, datasetHash, route.query],
    enabled: Boolean(datasetHash) || !route.resourceId,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) =>
        ["queued", "running", "cancelling"].includes(item.status),
      )
        ? 2000
        : false,
    queryFn: ({ signal }) =>
      localRequest(api, LocalExperimentRecordPageSchema, "list", query, signal),
  });
  const now = useExperimentClock(
    (definitions.data?.items ?? []).some((item) =>
      ["queued", "running", "cancelling"].includes(item.status),
    ),
  );
  const scoreColumns = [
    ...new Map(
      (definitions.data?.items ?? [])
        .flatMap((item) => item.graders)
        .map((grader) => [graderColumnKey(grader), grader]),
    ).values(),
  ];
  const target = (item: LocalExperimentRecord) =>
    item.configuration.request.policy.kind === "hosted_harness"
      ? item.configuration.request.policy.source.target?.kind === "workflow"
        ? item.configuration.request.policy.source.target.workflowId
        : item.configuration.request.policy.source.definitionId
      : "Model only";
  const openItem = (item: LocalExperimentRecord, detailTab = "tasks") =>
    navigate({
      ...route,
      page: "experiments",
      datasetKind: undefined,
      revision: undefined,
      contentHash: undefined,
      collection: "default",
      resourceId: item.id,
      detailTab,
      passId: null,
      after: null,
    });
  return (
    <>
      {selected ? (
        <div className="evaluation-selection-bar" role="region" aria-label="Selected Experiment">
          <span>
            Selected <strong>{selected.configuration.request.name ?? selected.id}</strong>
          </span>
          <button className="training-button" onClick={() => duplicate(selected)}>
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
            {definitions.data?.items.map((item) => (
              <tr
                key={item.id}
                tabIndex={0}
                onClick={() => openItem(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.target === event.currentTarget) openItem(item);
                }}
              >
                <td>
                  <input
                    type="checkbox"
                    className="training-chat-checkbox"
                    aria-label={`Select ${item.configuration.request.name}`}
                    checked={selected?.id === item.id}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setSelected(event.target.checked ? item : null)}
                  />
                </td>
                <td className="evaluation-centered">
                  <EvaluationStatus
                    iconOnly
                    status={
                      item.status === "completed" && item.counts.failed > 0 ? "failed" : item.status
                    }
                  />
                </td>
                <td>
                  <ExperimentIdentity
                    id={item.id}
                    title={item.configuration.request.name}
                    onOpen={() => openItem(item)}
                  />
                </td>
                <td className="evaluation-time-cell">
                  <EvaluationTime value={item.createdAt} />
                </td>
                <td className="evaluation-numeric">
                  {experimentElapsed(item.createdAt, item.completedAt, now) ?? "—"}
                </td>
                <td>
                  <span className="evaluation-cell-text" title={target(item)}>
                    {target(item)}
                  </span>
                </td>
                <td>
                  <span className="evaluation-cell-text" title={item.configuration.request.taskset.id}>
                    {item.configuration.request.taskset.id}
                  </span>
                  <small>Version {item.configuration.request.taskset.revision}</small>
                </td>
                <td>
                  <EvaluationModel name={item.model.modelId} />
                </td>
                <td className="evaluation-numeric">
                  {item.counts.completed}/
                  {Object.values(item.counts).reduce((sum, count) => sum + count, 0)}
                </td>
                {scoreColumns.map((grader) => (
                  <td key={graderColumnKey(grader)} className="evaluation-numeric">
                    <ExperimentFeedbackCell
                      api={api}
                      id={item.id}
                      manifestHash={item.executionHash}
                      available={Boolean(item.completedAt && item.cleanupComplete)}
                      graders={item.graders}
                      grader={grader}
                    />
                  </td>
                ))}
                <td>
                  {item.error ? (
                    <ExperimentFailureCell
                      label={item.error}
                      onDiagnostics={() => openItem(item, "diagnostics")}
                    />
                  ) : (
                    <span className="evaluation-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            <EvaluationTableState
              columns={10 + scoreColumns.length}
              loading={definitions.isPending}
              error={definitions.error?.message}
              empty={!definitions.data?.items.length}
              retry={() => void definitions.refetch()}
            >
              Run an Experiment to evaluate selected Dataset tasks locally.
            </EvaluationTableState>
          </tbody>
        </table>
      </div>
      {definitions.data?.nextCursor ? (
        <button
          type="button"
          className="training-button secondary evaluation-more"
          onClick={() => navigate({ ...route, after: definitions.data!.nextCursor })}
        >
          More experiments
        </button>
      ) : null}
    </>
  );
}
