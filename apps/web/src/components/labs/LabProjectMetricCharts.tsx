import { useMemo } from "react";
import type { ModelOverviewRun } from "./model-overview-runs";

type MetricPoint = {
  label: string;
  value: number;
};

type MetricChart = {
  description: string;
  format: (value: number) => string;
  points: MetricPoint[];
  title: string;
};

const MAX_POINTS = 12;
const CHART_WIDTH = 360;
const CHART_HEIGHT = 132;
const CHART_PADDING_X = 14;
const CHART_PADDING_Y = 14;

export function LabProjectMetricCharts({ runs }: { runs: ModelOverviewRun[] }) {
  const charts = useMemo(() => projectMetricCharts(runs), [runs]);

  return (
    <section className="training-detail-section labs-project-trends">
      <div className="labs-project-trends-heading">
        <div>
          <h2>Run trends</h2>
          <p>Recent training and evaluation signals across immutable runs.</p>
        </div>
        <span>Latest {MAX_POINTS} runs</span>
      </div>
      <div className="labs-project-chart-grid">
        {charts.map((chart) => (
          <ProjectMetricChart chart={chart} key={chart.title} />
        ))}
      </div>
    </section>
  );
}

function ProjectMetricChart({ chart }: { chart: MetricChart }) {
  const plot = chart.points.length ? chartGeometry(chart.points) : null;
  const latest = chart.points.at(-1) ?? null;

  return (
    <article className="labs-project-chart-card">
      <header>
        <div>
          <h3>{chart.title}</h3>
          <span>{chart.description}</span>
        </div>
        <strong>{latest ? chart.format(latest.value) : "—"}</strong>
      </header>
      {plot ? (
        <div className="labs-project-chart-plot">
          <svg
            aria-label={`${chart.title} by run`}
            role="img"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          >
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                className="labs-project-chart-grid-line"
                key={fraction}
                x1={CHART_PADDING_X}
                x2={CHART_WIDTH - CHART_PADDING_X}
                y1={CHART_HEIGHT * fraction}
                y2={CHART_HEIGHT * fraction}
              />
            ))}
            <polygon
              className="labs-project-chart-area"
              points={`${plot.points} ${CHART_WIDTH - CHART_PADDING_X},${CHART_HEIGHT - CHART_PADDING_Y} ${CHART_PADDING_X},${CHART_HEIGHT - CHART_PADDING_Y}`}
            />
            <polyline
              className="labs-project-chart-line"
              points={plot.points}
            />
            {plot.coordinates.map((point, index) => (
              <circle
                className="labs-project-chart-point"
                cx={point.x}
                cy={point.y}
                key={`${chart.points[index]!.label}:${index}`}
                r={index === plot.coordinates.length - 1 ? 3.5 : 2.25}
              >
                <title>{`${chart.points[index]!.label}: ${chart.format(chart.points[index]!.value)}`}</title>
              </circle>
            ))}
          </svg>
          <div className="labs-project-chart-axis">
            <span>{chart.points[0]!.label}</span>
            <span>{latest!.label}</span>
          </div>
        </div>
      ) : (
        <div className="labs-project-chart-empty">
          No comparable data reported yet
        </div>
      )}
    </article>
  );
}

function projectMetricCharts(runs: ModelOverviewRun[]): MetricChart[] {
  const trainingRuns = runs.filter((run) => run.kind !== "evaluation");
  const numberedTrainingRuns = trainingRuns
    .map((run, index) => ({ run, number: trainingRuns.length - index }))
    .slice(0, MAX_POINTS)
    .reverse();
  const evaluationScorePoints = runs.filter(run => run.evaluation)
    .slice(0, MAX_POINTS).reverse().map((run, index) => ({ label: `Eval ${index + 1}`, value: run.evaluation!.score }));
  const spendCeilingPoints = numberedTrainingRuns.flatMap(({ run, number }) =>
    run.spendCeiling !== null
      ? [{ label: `Run ${number}`, value: run.spendCeiling }]
      : [],
  );

  return [
    {
      title: "Mean reward",
      description: "Final reported reward",
      points: numberedTrainingRuns.flatMap(({ run, number }) =>
        run.reward !== null ? [{ label: `Run ${number}`, value: run.reward }] : [],
      ),
      format: formatDecimal,
    },
    {
      title: "Run completion",
      description: "Completed groups or attempts",
      points: numberedTrainingRuns.flatMap(({ run, number }) =>
        run.completion !== null
          ? [{ label: `Run ${number}`, value: run.completion }]
          : [],
      ),
      format: formatPercent,
    },
    {
      title: "Run duration",
      description: "Elapsed wall-clock minutes",
      points: numberedTrainingRuns.flatMap(({ run, number }) => run.durationMinutes !== null
        ? [{ label: `Run ${number}`, value: run.durationMinutes }] : []),
      format: formatMinutes,
    },
    evaluationScorePoints.length
      ? {
          title: "Evaluation score",
          description: "Recorded candidate score",
          points: evaluationScorePoints,
          format: formatDecimal,
        }
      : {
          title: "Spend ceiling",
          description: "Approved maximum per run",
          points: spendCeilingPoints,
          format: formatCurrency,
        },
  ];
}

function chartGeometry(points: MetricPoint[]) {
  let minimum = points[0]!.value;
  let maximum = points[0]!.value;
  for (const point of points.slice(1)) {
    minimum = Math.min(minimum, point.value);
    maximum = Math.max(maximum, point.value);
  }
  const range = maximum - minimum;
  const availableWidth = CHART_WIDTH - CHART_PADDING_X * 2;
  const availableHeight = CHART_HEIGHT - CHART_PADDING_Y * 2;
  const coordinates = points.map((point, index) => ({
    x:
      points.length === 1
        ? CHART_WIDTH / 2
        : CHART_PADDING_X + (index / (points.length - 1)) * availableWidth,
    y: range === 0
      ? CHART_HEIGHT / 2
      : CHART_PADDING_Y +
        (1 - (point.value - minimum) / range) * availableHeight,
  }));
  return {
    coordinates,
    points: coordinates.map((point) => `${point.x},${point.y}`).join(" "),
  };
}

function formatDecimal(value: number): string {
  return value.toFixed(3);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMinutes(value: number): string {
  return value < 1 ? `${Math.round(value * 60)}s` : `${value.toFixed(1)}m`;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}
