import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ExperimentRunDetails, ExperimentCaseInspection } from "openpond-sdk/experiments";
import { ExperimentGraderLabel } from "./ExperimentGraderLabel";
import { EvaluationCard } from "./EvaluationPresentation";
import { WorkspacePanel, useWorkspaceActions, useWorkspacePanelControls } from "./WorkspacePanel";
import type { WorkspaceApi } from "./workspace-api";
/** Population survives result failure. A read never replays or grades a task. */
export function AdmittedExperimentTasks({
  api,
  run,
}: {
  api: WorkspaceApi;
  run: ExperimentRunDetails;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [page, setPage] = useState(0),
    [cursor, setCursor] = useState<string | undefined>();
  const controls = useWorkspacePanelControls();
  useWorkspaceActions(selected ? [{ id: "case", label: "Task", onSelect: () => {} }] : []);
  const member = run.request.population.find((member) => member.receiptId === selected);
  const inspection = useQuery({
    queryKey: [
      "admitted-task",
      api.key,
      run.summary.id,
      run.summary.manifestHash,
      selected,
      cursor,
    ],
    enabled: Boolean(member),
    queryFn: ({ signal }) =>
      api.request<ExperimentCaseInspection>(
        "case",
        { id: run.summary.id, receiptId: selected, ...(cursor ? { afterId: cursor } : {}) },
        signal,
      ),
  });
  const rows = run.request.population.slice(page * 25, (page + 1) * 25);
  return (
    <>
      <table className="training-data-table evaluation-workspace-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Output</th>
            {run.configuration.graders.map((pin) => (
              <th key={pin.feedbackKey}>
                <ExperimentGraderLabel grader={pin} />
              </th>
            ))}
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((member) => (
            <tr key={member.receiptId}>
              <td>
                <button
                  className="training-text-button"
                  onClick={() => {
                    setSelected(member.receiptId);
                    setCursor(undefined);
                    controls?.select({ id: "case", label: "Task", onSelect: () => {} });
                  }}
                >
                  {member.taskId}
                </button>
                <small>Seed {member.seed}</small>
              </td>
              <td>—</td>
              {run.configuration.graders.map((pin) => (
                <td key={pin.feedbackKey}>—</td>
              ))}
              <td>—</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Task results are unavailable. These rows are the immutable admitted population.</p>
      <div>
        <button disabled={page === 0} onClick={() => setPage((page) => page - 1)}>
          Previous tasks
        </button>
        <button
          disabled={(page + 1) * 25 >= run.request.population.length}
          onClick={() => setPage((page) => page + 1)}
        >
          More tasks
        </button>
      </div>
      {member ? (
        <WorkspacePanel
          action="case"
          label="Task inspector"
          onRequestClose={() => setSelected(null)}
        >
          <header>
            <h2>{member.taskId}</h2>
          </header>
          {inspection.error ? (
            <p role="alert">
              Task evidence unavailable: {inspection.error.message}
              <button onClick={() => void inspection.refetch()}>Retry read</button>
            </p>
          ) : null}
          <EvaluationCard title="Retained input">
            <pre>
              {inspection.data?.input
                ? JSON.stringify(inspection.data.input, null, 2)
                : inspection.isPending
                  ? "Loading…"
                  : "—"}
            </pre>
          </EvaluationCard>
          <EvaluationCard title="Output">
            <pre>
              {inspection.data?.output !== undefined && inspection.data.output !== null
                ? JSON.stringify(inspection.data.output, null, 2)
                : "—"}
            </pre>
          </EvaluationCard>
          <EvaluationCard title="Trace">
            {inspection.data?.events.map((event, index) => (
              <details key={String(event.id ?? index)}>
                <summary>{String(event.type ?? "Event")}</summary>
                <pre>{JSON.stringify(event, null, 2)}</pre>
              </details>
            ))}
            {inspection.data?.nextEventCursor ? (
              <button onClick={() => setCursor(inspection.data!.nextEventCursor!)}>
                Next trace page
              </button>
            ) : null}
          </EvaluationCard>
        </WorkspacePanel>
      ) : null}
    </>
  );
}
