import { useMemo } from "react";
import type { ModelRun } from "@openpond/contracts";

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

export function LabProjectMetricCharts({ runs }: { runs: ModelRun[] }) {
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

function projectMetricCharts(runs: ModelRun[]): MetricChart[] {
  const trainingRuns = runs.filter((run) => run.kind !== "evaluation");
  const numberedTrainingRuns = trainingRuns
    .map((run, index) => ({ run, number: trainingRuns.length - index }))
    .slice(0, MAX_POINTS)
    .reverse();
  const evaluationRuns = runs
    .filter((run) => run.kind === "evaluation")
    .map((run, index, collection) => ({
      run,
      number: collection.length - index,
    }))
    .slice(0, MAX_POINTS)
    .reverse();
  const evaluationScorePoints = evaluationRuns.flatMap(({ run, number }) =>
    run.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1"
      ? [{
          label: `Eval ${number}`,
          value: run.receipt.quality.candidatePassRate,
        }]
      : [],
  );
  const spendCeilingPoints = numberedTrainingRuns.flatMap(({ run, number }) =>
    run.quote
      ? [{ label: `Run ${number}`, value: run.quote.maximumSpendUsd }]
      : [],
  );

  return [
    {
      title: "Mean reward",
      description: "Final reported reward",
      points: numberedTrainingRuns.flatMap(({ run, number }) =>
        run.reward ? [{ label: `Run ${number}`, value: run.reward.raw }] : [],
      ),
      format: formatDecimal,
    },
    {
      title: "Rollout completion",
      description: "Completed attempts versus plan",
      points: numberedTrainingRuns.flatMap(({ run, number }) =>
        run.evaluationProgress
          ? [{
              label: `Run ${number}`,
              value:
                run.evaluationProgress.completedAttempts /
                run.evaluationProgress.totalAttempts,
            }]
          : [],
      ),
      format: formatPercent,
    },
    {
      title: "Run duration",
      description: "Elapsed wall-clock minutes",
      points: numberedTrainingRuns.flatMap(({ run, number }) => {
        const end = run.completedAt ?? run.updatedAt;
        const duration = Date.parse(end) - Date.parse(run.startedAt);
        return Number.isFinite(duration) && duration >= 0
          ? [{ label: `Run ${number}`, value: duration / 60_000 }]
          : [];
      }),
      format: formatMinutes,
    },
    evaluationScorePoints.length
      ? {
          title: "Evaluation score",
          description: "Candidate pass rate",
          points: evaluationScorePoints,
          format: formatPercent,
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
