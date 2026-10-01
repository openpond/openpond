import { EvaluationTableState } from "./EvaluationTableState";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceApi } from "./workspace-api";
type Usage = { totalTokens: number | null; costUsd: number | null };
type CaseUsage = {
  executionId: string;
  receiptId: string;
  policy: Usage;
  grader: Usage;
  compute: { costUsd: number | null; sandboxId: string | null; receiptId: string | null } | null;
};
const cost = (value: number | null) => (value === null ? "Unknown" : `$${value.toFixed(6)}`);
export function CaseUsage({
  api,
  executionId,
  receiptId,
  pass,
  usage,
}: {
  api: WorkspaceApi;
  executionId: string;
  receiptId: string;
  pass: boolean;
  usage: Usage;
}) {
  const accounting = useQuery({
    queryKey: ["evaluation-workspace", api.key, "caseUsage", executionId, receiptId],
    queryFn: ({ signal }) =>
      api.request<CaseUsage>("caseUsage", { id: executionId, receiptId }, signal),
  });
  return (
    <>
      {pass ? (
        <>
          <h3>Scoring pass grader usage</h3>
          <p>
            {usage.totalTokens === null
              ? "Tokens unknown"
              : `${usage.totalTokens.toLocaleString()} tokens`}{" "}
            · {cost(usage.costUsd)}
          </p>
        </>
      ) : null}
      <h3>{pass ? "Original Experiment usage" : "Recorded Experiment usage"}</h3>
      <table className="training-data-table">
        <thead>
          <tr>
            <th>Calls</th>
            <th>Tokens</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {accounting.data
            ? (["policy", "grader"] as const).map((kind) => (
                <tr key={kind}>
                  <th>{kind === "policy" ? "Model / target" : "Graders"}</th>
                  <td>{accounting.data[kind].totalTokens?.toLocaleString() ?? "Unknown"}</td>
                  <td>{cost(accounting.data[kind].costUsd)}</td>
                </tr>
              ))
            : null}
          {accounting.data?.compute ? (
            <tr>
              <th>Compute</th>
              <td>Not applicable</td>
              <td>{cost(accounting.data.compute.costUsd)}</td>
            </tr>
          ) : null}
          <EvaluationTableState
            columns={3}
            loading={accounting.isPending}
            error={accounting.error?.message}
            empty={!accounting.data}
            retry={() => void accounting.refetch()}
          >
            Open a case with retained accounting to inspect its recorded usage.
          </EvaluationTableState>
        </tbody>
      </table>
    </>
  );
}
