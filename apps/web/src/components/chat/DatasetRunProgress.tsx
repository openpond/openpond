import { ErrorToast } from "../common/ErrorToast";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  LocalExperimentCaseInspectionSchema,
  type LocalExperimentCaseInspection,
  type ChatResourceSummary,
  type ChatExperimentView,
} from "@openpond/contracts";
import { chatResourceRequest } from "../../api/chat-resource-api";
import type { ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { DropdownSelect } from "../DropdownSelect";
import { EvaluationStatus } from "../labs/workspace/EvaluationPresentation";
import { TrainingMetricWorkbench } from "../training/TrainingMetricWorkbench";
import { RunFlowDiagram, type RunFlowNode } from "../training/RunFlowDiagram";
import { activeRun, resourceIdentity } from "./dataset-workspace-data";

export function DatasetRunProgress({
  run,
  view,
  loading,
  error,
  onRefresh,
}: {
  run: ChatResourceSummary;
  view?: ChatExperimentView;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
}) {
  const live = activeRun(run.state);
  const cases = view?.cases ?? [],
    total = run.taskCount ?? cases.length;
  const generated = cases.filter((item) => item.output !== null).length;
  const graded = cases.filter((item) => item.score !== null).length;
  const settled = cases.filter((item) => !["pending", "running"].includes(item.status)).length;
  const preparing = live && !cases.some((item) => item.status !== "pending");
  const generating = live && !preparing && generated < total;
  const grading = live && !preparing && !generating && graded < total;
  const nodes: RunFlowNode[] = [
    {
      label: "Prepare",
      state: preparing ? "active" : cases.length ? "done" : "pending",
      status: preparing ? "Starting" : cases.length ? "Recorded" : "Waiting",
    },
    {
      label: "Rollouts",
      state: generating
        ? "active"
        : total > 0 && generated === total
          ? "done"
          : live
            ? "pending"
            : "missing",
      status: generating ? "Generating answers" : "Model outputs",
      detail: `${generated}/${total} generated`,
      progress: total ? generated / total : 0,
    },
    {
      label: "Grade",
      state: grading
        ? "active"
        : total > 0 && graded === total
          ? "done"
          : live
            ? "pending"
            : "missing",
      status: grading ? "Scoring" : "Dataset graders",
      detail: `${graded}/${total} graded`,
      progress: total ? graded / total : 0,
    },
    {
      label: "Results",
      state:
        !live && run.state === "completed" && !error
          ? "done"
          : live && settled === total
            ? "active"
            : "pending",
      status: live ? "Waiting for evidence" : error ? "Refresh unavailable" : run.state,
      detail: run.score == null ? "Score unavailable" : `Mean score ${run.score.toFixed(3)}`,
    },
  ];
  return (
    <section className="dataset-workspace-run" aria-label="Selected experiment progress">
      <RunFlowDiagram nodes={nodes} live={live && !error} />
      {error ? (
        <ErrorToast error={error.message}><button className="training-text-button" onClick={onRefresh}>
            Retry
          </button></ErrorToast>
      ) : loading ? (
        <p role="status">Loading retained run evidence…</p>
      ) : null}
    </section>
  );
}

export function DatasetRunEvidence({
  connection,
  run,
  view,
}: {
  connection: ClientConnection;
  run: ChatResourceSummary;
  view?: ChatExperimentView;
}) {
  const cases = view?.cases ?? [],
    graded = cases.filter((item) => item.score !== null).length;
  return cases.length ? (
    <>
      <div className="dataset-workspace-attempts" aria-label="Rollout attempts">
        {cases.map((item, index) => (
          <span
            key={item.id}
            className={`dataset-workspace-attempt ${item.status === "running" ? "active" : item.error ? "failed" : item.score !== null ? "scored" : "pending"}`}
            style={
              item.score !== null
                ? { opacity: 0.35 + 0.65 * Math.max(0, Math.min(1, item.score)) }
                : undefined
            }
            title={`${item.taskId}: ${item.error ?? (item.score === null ? item.status : `score ${item.score}`)}`}
            aria-label={`Case ${index + 1}: ${item.taskId}, ${item.score === null ? item.status : `score ${item.score}`}`}
          />
        ))}
      </div>
      {graded ? (
        <details className="dataset-workspace-charts">
          <summary>Score chart</summary>
          <TrainingMetricWorkbench
            series={[
              {
                id: "evaluation.score",
                label: "Case score",
                xLabel: "Case",
                bounds: cases.every(
                  (item) => item.score === null || (item.score >= 0 && item.score <= 1),
                )
                  ? [0, 1]
                  : undefined,
                points: cases.flatMap((item, index) =>
                  item.score === null ? [] : [{ step: index + 1, value: item.score }],
                ),
              },
            ]}
          />
        </details>
      ) : null}
      <details className="dataset-workspace-cases">
        <summary>Answers and grader scores</summary>
        <p>
          Each row shows the model’s answer to one dataset task and the score given by its graders.
        </p>
        <div className="evaluation-table-scroll evaluation-table-frame">
          <table className="training-data-table evaluation-workspace-table">
            <thead>
              <tr>
                <th>Example</th>
                <th>Status</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.taskId}
                    {item.output !== null ? (
                      <details className="dataset-workspace-example-answer">
                        <summary>Model answer</summary>
                        <pre>{item.output}</pre>
                      </details>
                    ) : null}
                  </td>
                  <td>
                    <EvaluationStatus status={item.status} />
                    {item.error ? <small>{item.error}</small> : null}
                  </td>
                  <td className="evaluation-numeric">{item.score?.toFixed(3) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <DatasetRunLogs key={resourceIdentity(run)} connection={connection} run={run} cases={cases} />
    </>
  ) : null;
}

function DatasetRunLogs({
  connection,
  run,
  cases,
}: {
  connection: ClientConnection;
  run: ChatResourceSummary;
  cases: ChatExperimentView["cases"];
}) {
  const [open, setOpen] = useState(false),
    [caseId, setCaseId] = useState(cases[0]?.id ?? "");
  const local = run.location === "local" && !run.owner && !run.profileRef;
  const logs = useInfiniteQuery<LocalExperimentCaseInspection>({
    queryKey: [
      "dataset-workspace-logs",
      connectionQueryScope(connection),
      resourceIdentity(run),
      caseId,
    ],
    enabled: open && local && Boolean(caseId),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.trace.nextCursor ?? undefined,
    queryFn: async ({ signal, pageParam }) =>
      LocalExperimentCaseInspectionSchema.parse(
        await chatResourceRequest(
          connection,
          "experiment",
          {
            action: "case",
            payload: {
              id: run.id,
              receiptId: caseId,
              limit: 100,
              ...(pageParam ? { afterSequence: pageParam } : {}),
            },
          },
          signal,
        ),
      ),
    refetchInterval: activeRun(run.state) ? 2000 : false,
  });
  return (
    <details
      className="dataset-workspace-logs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Logs</summary>
      {local ? (
        <>
          <DropdownSelect
            compact
            floating
            label="Log case"
            value={caseId}
            options={cases.map((item) => ({ value: item.id, label: item.taskId }))}
            onChange={setCaseId}
          />
          {logs.error ? (
            <ErrorToast error={logs.error.message} />
          ) : logs.isPending ? (
            <p role="status">Loading case trace…</p>
          ) : (
            <ol>
              {logs.data?.pages
                .flatMap((page) => page.trace.items)
                .map((item) => (
                  <li key={item.sequence}>
                    <strong>{item.type.replaceAll(/[._]/g, " ")}</strong>
                    <details>
                      <summary>Details</summary>
                      <pre>{JSON.stringify(item.payload, null, 2)}</pre>
                    </details>
                  </li>
                ))}
            </ol>
          )}
          {logs.hasNextPage ? (
            <button
              className="training-button secondary"
              disabled={logs.isFetchingNextPage}
              onClick={() => void logs.fetchNextPage()}
            >
              More logs
            </button>
          ) : null}
        </>
      ) : (
        <ol>
          {cases.map((item) => (
            <li key={item.id}>
              <strong>{item.taskId}</strong>
              <span>{item.error ?? item.status}</span>
              {item.output ? (
                <details>
                  <summary>Output</summary>
                  <pre>{item.output}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
