import type { ReactNode } from "react";
import { EvaluationTableState } from "./EvaluationTableState";
export function CaseTableState({
  headers,
  loading,
  error,
  retry,
}: {
  headers: ReactNode[];
  loading: boolean;
  error?: string;
  retry: () => void;
}) {
  return (
    <table className="training-data-table evaluation-workspace-table">
      <thead>
        <tr>
          {headers.map((header, index) => (
            <th key={index}>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        <EvaluationTableState
          columns={headers.length}
          loading={loading}
          error={error}
          empty
          retry={retry}
        >
          Case results become available when this Experiment finishes. Start or open a completed
          Experiment to inspect its retained results.
        </EvaluationTableState>
      </tbody>
    </table>
  );
}
