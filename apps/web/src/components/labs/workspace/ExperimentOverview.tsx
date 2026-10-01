import { EvaluationCard } from "./EvaluationPresentation";
export type OverviewExecution = {
  id: string;
  name: string;
  model: string;
  status: string;
  createdAt: string;
  total: number;
  completed: number;
  failed: number;
  costUsd?: number | null;
};
export type OverviewMetricPoint = { id: string; label: string; value: number | null };
function MetricChart({
  title,
  points,
  unit,
  note,
  empty,
}: {
  title: string;
  points: OverviewMetricPoint[];
  unit: string;
  note: string;
  empty: string;
}) {
  const known = points.filter((point) => point.value !== null),
    maximum = Math.max(0, ...known.map((point) => point.value!));
  return (
    <EvaluationCard title={title}>
      <p>{note}</p>
      {known.length ? (
        <>
          <svg
            className="evaluation-metric-chart"
            viewBox="0 0 600 160"
            role="img"
            aria-label={`${title}: ${points.map((point) => `${point.label}: ${point.value === null ? "unknown" : `${point.value.toLocaleString()} ${unit}`}`).join("; ")}`}
          >
            <line x1="0" y1="140" x2="600" y2="140" stroke="currentColor" opacity=".2" />
            {points.map((point, index) => {
              const slot = 600 / Math.max(1, points.length),
                height = point.value === null ? 0 : (point.value / Math.max(1, maximum)) * 120;
              return (
                <g key={point.id}>
                  <title>
                    {point.label}:{" "}
                    {point.value === null ? "Unknown" : `${point.value.toLocaleString()} ${unit}`}
                  </title>
                  {point.value === null ? (
                    <text
                      x={(index + 0.5) * slot}
                      y="138"
                      textAnchor="middle"
                      fill="currentColor"
                      fontSize="12"
                    >
                      ?
                    </text>
                  ) : (
                    <rect
                      x={index * slot + slot * 0.15}
                      y={140 - height}
                      width={slot * 0.7}
                      height={height}
                      rx="3"
                      fill="#22d3ee"
                    />
                  )}
                </g>
              );
            })}
          </svg>
          <p>
            {known.length} recorded observations / maximum {maximum.toLocaleString()} {unit}
            {known.length < points.length ? ` / ${points.length - known.length} unknown` : ""}
          </p>
        </>
      ) : (
        <div className="evaluation-metric-empty">{empty}</div>
      )}
    </EvaluationCard>
  );
}
export function ExperimentOverview({
  runs,
  tokens,
  loading,
  error,
  retry,
  tokenNote,
}: {
  runs: OverviewExecution[];
  tokens: OverviewMetricPoint[];
  loading: boolean;
  error?: string;
  retry: () => void;
  onSelect: (id: string) => void;
  onConfiguration: (id: string) => void;
  tokenNote: string;
}) {
  const chronological = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <section className="evaluation-experiment-overview">
      {loading ? <p role="status">Loading retained measurements…</p> : null}
      {error ? (
        <p role="alert">
          {error} <button onClick={retry}>Retry measurements</button>
        </p>
      ) : null}
      <div className="evaluation-experiment-charts">
        <MetricChart
          title="Tokens used"
          points={tokens}
          unit="tokens"
          note={tokenNote}
          empty="Token measurements are not available for this Experiment."
        />
        <MetricChart
          title="Case error rate"
          unit="%"
          points={chronological.map((run) => ({
            id: run.id,
            label: run.id,
            value:
              run.completed + run.failed ? (run.failed / (run.completed + run.failed)) * 100 : null,
          }))}
          note="Failed / completed and failed cases. Pending, cancelled and unknown cases are excluded."
          empty="This Experiment has no completed or failed cases yet."
        />
      </div>
    </section>
  );
}
