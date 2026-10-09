import { ExperimentIdentity, useExperimentClock } from "./ExperimentIdentity";
import { useState } from "react";
import type { z } from "zod";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import type { LocalExperimentRecord } from "@openpond/contracts";
import { ExperimentFeedbackCell, graderColumnKey } from "./ExperimentFeedbackCell";
import { EvaluationTableState } from "./EvaluationTableState";
import { useQuery } from "@tanstack/react-query";
import { LocalExperimentRecordPageSchema } from "@openpond/contracts";
import { EvaluationModel, EvaluationStatus } from "./EvaluationPresentation";
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
  return (
    <>
      {selected ? (
        <button className="training-button" onClick={() => duplicate(selected)}>
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
                <small>Mean score · this run</small>
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
              onClick={() =>
                navigate({
                  ...route,
                  page: "experiments",
                  datasetKind: undefined,
                  revision: undefined,
                  contentHash: undefined,
                  collection: "default",
                  resourceId: item.id,
                  detailTab: "tasks",
                  after: null,
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.target === event.currentTarget)
                  navigate({
                    ...route,
                    page: "experiments",
                    datasetKind: undefined,
                    revision: undefined,
                    contentHash: undefined,
                    collection: "default",
                    resourceId: item.id,
                    detailTab: "tasks",
                    after: null,
                  });
              }}
            >
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${item.configuration.request.name}`}
                  checked={selected?.id === item.id}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setSelected(event.target.checked ? item : null)}
                />
              </td>
              <td>
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
                  createdAt={item.createdAt}
                  startedAt={item.status === "queued" ? null : item.createdAt}
                  completedAt={item.completedAt}
                  now={now}
                  onOpen={() =>
                    navigate({
                      ...route,
                      page: "experiments",
                      resourceId: item.id,
                      detailTab: "tasks",
                      passId: null,
                    })
                  }
                />
              </td>
              <td>
                {item.configuration.request.policy.kind === "hosted_harness"
                  ? item.configuration.request.policy.source.definitionId
                  : "Model"}
              </td>
              <td>
                {item.configuration.request.taskset.id}
                <small>v{item.configuration.request.taskset.revision}</small>
              </td>
              <td>
                <EvaluationModel name={item.model.modelId} />
              </td>
              <td>
                {item.counts.completed}/
                {Object.values(item.counts).reduce((sum, count) => sum + count, 0)}
              </td>
              {scoreColumns.map((grader) => (
                <td key={graderColumnKey(grader)}>
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
              <td onClick={(event) => event.stopPropagation()}>
                {item.error ? (
                  <details>
                    <summary>Failure</summary>
                    <p>{item.error}</p>
                    <button
                      onClick={() =>
                        navigate({
                          ...route,
                          page: "experiments",
                          resourceId: item.id,
                          detailTab: "diagnostics",
                          passId: null,
                        })
                      }
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
            loading={definitions.isPending}
            error={definitions.error?.message}
            empty={!definitions.data?.items.length}
            retry={() => void definitions.refetch()}
          >
            Run an Experiment to evaluate selected Dataset tasks locally.
          </EvaluationTableState>
        </tbody>
      </table>
      {definitions.data?.nextCursor ? (
        <button
          type="button"
          onClick={() => navigate({ ...route, after: definitions.data!.nextCursor })}
        >
          More experiments
        </button>
      ) : null}
    </>
  );
}
