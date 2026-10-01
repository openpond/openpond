import { EvaluationTableState } from "./EvaluationTableState";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LocalExperimentCaseInspectionSchema,
  type LocalExperimentResult,
} from "@openpond/contracts";
import { localRequest } from "./local-workspace-api";
import { WorkspacePanel, useWorkspaceActions, useWorkspacePanelControls } from "./WorkspacePanel";
import { EvaluationCard, EvaluationStatus } from "./EvaluationPresentation";
import type { WorkspaceApi } from "./workspace-api";

export function LocalExperimentCases({
  api,
  result,
}: {
  api: WorkspaceApi;
  result: LocalExperimentResult;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [after, setAfter] = useState<number>();
  const controls = useWorkspacePanelControls(),
    member = result.cases.find((row) => row.receiptId === selected);
  useWorkspaceActions(member ? [{ id: "case", label: "Case", onSelect: () => {} }] : []);
  const inspection = useQuery({
    queryKey: ["local-experiments", api.key, "case", result.execution.id, selected, after],
    enabled: Boolean(member),
    queryFn: ({ signal }) =>
      localRequest(
        api,
        LocalExperimentCaseInspectionSchema,
        "case",
        {
          id: result.execution.id,
          receiptId: selected,
          ...(after ? { afterSequence: after } : {}),
        },
        signal,
      ),
  });
  function inspect(id: string) {
    setSelected(id);
    setAfter(undefined);
    controls?.select({ id: "case", label: "Case", onSelect: () => {} });
  }
  return (
    <>
      <p>{result.cases.length} retained local cases</p>
      <table className="training-data-table evaluation-workspace-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Seed</th>
            <th>Status</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {result.cases.map((row) => (
            <tr
              key={row.receiptId}
              tabIndex={0}
              onClick={() => inspect(row.receiptId)}
              onKeyDown={(event) => {
                if (event.key === "Enter") inspect(row.receiptId);
              }}
            >
              <td>{row.taskId}</td>
              <td>{row.seed}</td>
              <td>
                <EvaluationStatus status={row.status} />
              </td>
              <td>{row.grade?.score ?? "Unavailable"}</td>
            </tr>
          ))}
          <EvaluationTableState columns={4} empty={!result.cases.length}>Start an execution to retain case results here.</EvaluationTableState>
        </tbody>
      </table>
      {member ? (
        <WorkspacePanel action="case" label="Local case inspector" onRequestClose={() => setSelected(null)}>
          <header>
            <h2>{member.taskId}</h2>

          </header>
          <EvaluationCard title="Retained input">
            <pre>
              {JSON.stringify(
                { input: member.input, context: member.policyVisibleContext },
                null,
                2,
              )}
            </pre>
          </EvaluationCard>
          <EvaluationCard title="Output">
            <pre>{member.output ?? "No completed output retained."}</pre>
            {member.error ? <p role="alert">{member.error}</p> : null}
          </EvaluationCard>
          <EvaluationCard title="Grading">
            <pre>{JSON.stringify(member.grade, null, 2)}</pre>
          </EvaluationCard>
          <EvaluationCard title="Available trace">
            {inspection.error ? <p role="alert">{inspection.error.message}</p> : null}
            {inspection.isPending ? (
              <p>Loading retained trace…</p>
            ) : inspection.data?.trace.items.length ? (
              <ol>
                {inspection.data.trace.items.map((event) => (
                  <li key={event.sequence}>
                    <strong>
                      {event.sequence} · {event.type}
                    </strong>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No model trace events retained.</p>
            )}
            {after ? (
              <button type="button" onClick={() => setAfter(undefined)}>
                First trace page
              </button>
            ) : null}
            {inspection.data?.trace.nextCursor ? (
              <button type="button" onClick={() => setAfter(inspection.data!.trace.nextCursor!)}>
                Next trace page
              </button>
            ) : null}
            {member.profileNative ? <EvaluationCard title="Profile execution evidence"><pre>{JSON.stringify(member.profileNative,null,2)}</pre></EvaluationCard> : null}
            {member.native ? (
              <details>
                <summary>Native turn evidence</summary>
                <pre>{JSON.stringify(member.native, null, 2)}</pre>
              </details>
            ) : null}
          </EvaluationCard>
        </WorkspacePanel>
      ) : null}
    </>
  );
}
