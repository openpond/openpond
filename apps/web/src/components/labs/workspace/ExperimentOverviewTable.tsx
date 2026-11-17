import type { ExperimentCollectionRecord } from "./experiment-collection-record";
import type { ModelsRoute } from "../models-route";
import { experimentRecordRoute } from "./experiment-record-route";
import { EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { EvaluationTableState } from "./EvaluationTableState";

export function ExperimentOverviewTable({
  rows,
  loading,
  route,
  navigate,
}: {
  rows: ExperimentCollectionRecord[];
  loading: boolean;
  route: ModelsRoute;
  navigate(route: ModelsRoute): void;
}) {
  return (
    <div className="training-table-wrap">
      <table className="training-data-table overview-experiments-table">
        <thead>
          <tr>
            <th>Experiment</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <button
                  type="button"
                  className="labs-version-row-button"
                  onClick={() => navigate(experimentRecordRoute(row, route))}
                >
                  {row.name || row.id}
                </button>
                <div className="training-muted">
                  {row.kind === "training"
                    ? (row.execution.method?.toUpperCase() ?? "Training")
                    : row.kind === "managed-modification"
                      ? row.execution.method.replaceAll("_", " ")
                      : row.kind === "modification"
                        ? "Recorded"
                        : row.kind === "draft"
                          ? "Draft"
                          : "Evaluation"}
                </div>
                {row.error ? (
                  <div className="overview-result-error" title={row.error}>
                    {row.error}
                  </div>
                ) : null}
              </td>
              <td>
                <EvaluationStatus status={row.status} />
              </td>
              <td>
                <EvaluationTime value={row.createdAt} />
              </td>
            </tr>
          ))}
          <EvaluationTableState columns={3} loading={loading} empty={!rows.length}>
            Your training and evaluation runs will appear here.
          </EvaluationTableState>
        </tbody>
      </table>
    </div>
  );
}
