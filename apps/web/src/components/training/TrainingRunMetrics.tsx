import { useMemo, useState } from "react";
import type {
  PolicyOptimizationMetric,
  SftStepMetric,
  TrainingRunDetail,
} from "@openpond/contracts";
import { useErrorToast } from "../../app/AppToastContext";

type MetricKey =
  | "loss"
  | "reward"
  | "policyLoss"
  | "advantageLoss"
  | "learningRate"
  | "gradientNorm"
  | "meanTokenAccuracy"
  | "preferenceAccuracy"
  | "preferenceMargin"
  | "chosenReward"
  | "rejectedReward"
  | "chosenLogProbability"
  | "rejectedLogProbability"
  | "entropy"
  | "memoryBytes";
const METRICS: Array<{ key: MetricKey; label: string; format: (value: number) => string }> = [
  { key: "loss", label: "Loss", format: compactNumber },
  { key: "reward", label: "Reward", format: compactNumber },
  { key: "policyLoss", label: "Policy loss", format: compactNumber },
  { key: "advantageLoss", label: "Advantage loss", format: compactNumber },
  { key: "learningRate", label: "Learning rate", format: scientificNumber },
  { key: "gradientNorm", label: "Gradient norm", format: compactNumber },
  { key: "meanTokenAccuracy", label: "Token accuracy", format: percent },
  { key: "preferenceAccuracy", label: "Preference accuracy", format: percent },
  { key: "preferenceMargin", label: "Preference margin", format: compactNumber },
  { key: "chosenReward", label: "Chosen reward", format: compactNumber },
  { key: "rejectedReward", label: "Rejected reward", format: compactNumber },
  { key: "chosenLogProbability", label: "Chosen log probability", format: compactNumber },
  { key: "rejectedLogProbability", label: "Rejected log probability", format: compactNumber },
  { key: "entropy", label: "Entropy", format: compactNumber },
  { key: "memoryBytes", label: "Memory", format: bytes },
];

type PolicyMetricKey =
  | "meanReward"
  | "meanReturn"
  | "learningRate"
  | "policyLoss"
  | "valueLoss"
  | "kl"
  | "entropy"
  | "policyClipFraction"
  | "valueClipFraction"
  | "explainedVariance";

const POLICY_METRICS: Array<{
  key: PolicyMetricKey;
  label: string;
  format: (value: number) => string;
}> = [
  { key: "meanReward", label: "Reward", format: compactNumber },
  { key: "meanReturn", label: "Return", format: compactNumber },
  { key: "learningRate", label: "Learning rate", format: scientificNumber },
  { key: "policyLoss", label: "Policy loss", format: compactNumber },
  { key: "valueLoss", label: "Value loss", format: compactNumber },
  { key: "kl", label: "KL", format: compactNumber },
  { key: "entropy", label: "Entropy", format: compactNumber },
  { key: "policyClipFraction", label: "Policy clip fraction", format: percent },
  { key: "valueClipFraction", label: "Value clip fraction", format: percent },
  { key: "explainedVariance", label: "Explained variance", format: compactNumber },
];

export function TrainingRunMetrics({ detail, loading, error }: { detail: TrainingRunDetail | null; loading: boolean; error: string | null }) {
  useErrorToast(error, { prefix: "Training metrics" });
  const stepMetrics = useMemo(
    () => uniqueStepMetrics(detail?.stepMetrics ?? []),
    [detail?.stepMetrics],
  );
  const available = useMemo(
    () => METRICS.filter((metric) => stepMetrics.some((point) => point[metric.key] != null)),
    [stepMetrics],
  );
  const [requestedMetric, setRequestedMetric] = useState<MetricKey>("loss");
  const active = available.find((metric) => metric.key === requestedMetric) ?? available[0] ?? METRICS[0]!;
  const points = stepMetrics.flatMap((point) => point[active.key] == null ? [] : [{ step: point.step, value: point[active.key] as number }]);
  const policyMetrics = useMemo(
    () => uniquePolicyMetrics(detail?.policyMetrics ?? []),
    [detail?.policyMetrics],
  );
  const policyAvailable = useMemo(
    () =>
      POLICY_METRICS.filter((metric) =>
        policyMetrics.some((point) => point[metric.key] != null)),
    [policyMetrics],
  );
  const [requestedPolicyMetric, setRequestedPolicyMetric] =
    useState<PolicyMetricKey>("meanReward");
  const activePolicy =
    policyAvailable.find((metric) => metric.key === requestedPolicyMetric)
    ?? policyAvailable[0]
    ?? POLICY_METRICS[0]!;
  const policyPoints = policyMetrics.flatMap((point) =>
    point[activePolicy.key] == null
      ? []
      : [{ step: point.step, value: point[activePolicy.key] as number }]);
  const policyRewardPoints = policyMetrics.flatMap((point) =>
    point.meanReward == null
      ? []
      : [{ step: point.step, value: point.meanReward }]);
  const policyLearningRatePoints = policyMetrics.flatMap((point) =>
    point.learningRate == null
      ? []
      : [{ step: point.step, value: point.learningRate }]);
  const policyKlPoints = policyMetrics.flatMap((point) =>
    point.kl == null ? [] : [{ step: point.step, value: point.kl }]);
  const policyEntropyPoints = policyMetrics.flatMap((point) =>
    point.entropy == null ? [] : [{ step: point.step, value: point.entropy }]);
  const policyClipPoints = policyMetrics.flatMap((point) =>
    point.policyClipFraction == null
      ? []
      : [{ step: point.step, value: point.policyClipFraction }]);
  const rolloutPoints = useMemo(
    () => rolloutRewardPoints(detail?.events ?? []),
    [detail?.events],
  );
  const managedTelemetry = useMemo(
    () => managedTelemetryPoints(detail?.events ?? []),
    [detail?.events],
  );
  const summary = detail ? finalSummary(detail) : {};

  if (loading && !detail) return <div className="training-run-placeholder">Loading training metrics…</div>;
  if (error && !detail) return <div className="training-run-placeholder">Training metrics are unavailable.</div>;
  if (!detail) return <div className="training-run-placeholder">Select a training run to inspect its metrics.</div>;
  if (policyMetrics.length) {
    if (
      policyMetrics.some((metric) => metric.method === "grpo") ||
      detail.job.metadata.trainingMethod === "grpo"
    ) {
      return (
        <GrpoChartGrid
          learningRatePoints={policyLearningRatePoints}
          rewardPoints={policyRewardPoints}
          rolloutPoints={rolloutPoints}
          klPoints={policyKlPoints}
          entropyPoints={policyEntropyPoints}
          clipPoints={policyClipPoints}
          lossPoints={managedTelemetry.get("optimizer.loss") ?? []}
          gradientNormPoints={managedTelemetry.get("optimizer.gradient_norm") ?? []}
        />
      );
    }
    const latest = policyMetrics.at(-1)!;
    return (
      <div className="training-run-metrics">
        <div className="training-metric-summary">
          <MetricFact label="Optimizer steps" value={latest.step} />
          <MetricFact
            label="Latest reward"
            value={latest.meanReward == null ? null : compactNumber(latest.meanReward)}
          />
          <MetricFact
            label="Policy loss"
            value={latest.policyLoss == null ? null : compactNumber(latest.policyLoss)}
          />
          <MetricFact label="Rollouts" value={rolloutPoints.length || null} />
          <MetricFact
            label="Learning rate"
            value={latest.learningRate == null ? null : scientificNumber(latest.learningRate)}
          />
          <MetricFact
            label="Environment executions"
            value={latest.environmentExecutions}
          />
        </div>
        {policyAvailable.length ? (
          <>
            <div className="training-metric-tabs" role="tablist" aria-label="Policy metrics">
              {policyAvailable.map((metric) => (
                <button
                  className={metric.key === activePolicy.key ? "active" : ""}
                  key={metric.key}
                  role="tab"
                  type="button"
                  aria-selected={metric.key === activePolicy.key}
                  onClick={() => setRequestedPolicyMetric(metric.key)}
                >
                  {metric.label}
                </button>
              ))}
            </div>
            <div className="training-metric-chart-grid">
              {rolloutPoints.length ? (
                <MetricChartCard
                  axisLabel="Rollout"
                  format={compactNumber}
                  label="Rollout reward"
                  points={rolloutPoints}
                />
              ) : null}
              <MetricChartCard
                format={activePolicy.format}
                label={activePolicy.label}
                points={policyPoints}
              />
            </div>
          </>
        ) : null}
      </div>
    );
  }
  const rft = detail.job.metadata.trainingMethod === "grpo";
  const lossValues = stepMetrics.flatMap((metric) => metric.loss == null ? [] : [metric.loss]);
  const learningRatePoints = stepMetrics.flatMap((point) =>
    point.learningRate == null
      ? []
      : [{ step: point.step, value: point.learningRate }],
  );
  const rewardPoints = stepMetrics.flatMap((point) =>
    point.reward == null ? [] : [{ step: point.step, value: point.reward }],
  );

  if (rft) {
    const observedUpdates = detail.job.metadata.optimizerUpdatesObserved;
    const committedStepLimit =
      typeof observedUpdates === "number" && Number.isFinite(observedUpdates)
        ? Math.max(0, observedUpdates)
        : null;
    return (
      <GrpoChartGrid
        learningRatePoints={
          committedStepLimit == null
            ? learningRatePoints
            : learningRatePoints.filter(
                (point) => point.step <= committedStepLimit,
              )
        }
        rewardPoints={
          committedStepLimit == null
            ? rewardPoints
            : rewardPoints.filter((point) => point.step <= committedStepLimit)
        }
        rolloutPoints={rolloutPoints}
        klPoints={[]}
        entropyPoints={[]}
        clipPoints={[]}
        lossPoints={managedTelemetry.get("optimizer.loss") ?? []}
        gradientNormPoints={managedTelemetry.get("optimizer.gradient_norm") ?? []}
      />
    );
  }

  return (
    <div className="training-run-metrics">
      <div className="training-metric-summary">
        <MetricFact label="Steps" value={summary.steps ?? lastStep(stepMetrics)} />
        <MetricFact label="Final loss" value={summary.trainLoss == null ? lossValues.at(-1) == null ? null : compactNumber(lossValues.at(-1)!) : compactNumber(summary.trainLoss)} />
        <MetricFact label="Peak memory" value={peakMemory(detail.stepMetrics)} />
        <MetricFact label="Adapter parameters" value={summary.adapterParameterCount == null ? null : summary.adapterParameterCount.toLocaleString()} />
      </div>
      {available.length ? (
        <>
          <div className="training-metric-tabs" role="tablist" aria-label="Training metrics">
            {available.map((metric) => <button key={metric.key} type="button" role="tab" aria-selected={metric.key === active.key} className={metric.key === active.key ? "active" : ""} onClick={() => setRequestedMetric(metric.key)}>{metric.label}</button>)}
          </div>
          <div className="training-metric-chart-grid">
            <MetricChartCard
              label={active.label}
              points={points}
              format={active.format}
            />
            {active.key !== "learningRate" && learningRatePoints.length ? (
              <MetricChartCard
                label="Learning rate"
                points={learningRatePoints}
                format={scientificNumber}
              />
            ) : null}
          </div>
        </>
      ) : <div className="training-run-placeholder">This earlier run recorded its final result but not per-step Trainer logs.</div>}
    </div>
  );
}

function GrpoChartGrid({
  rewardPoints,
  rolloutPoints,
  learningRatePoints,
  klPoints,
  entropyPoints,
  clipPoints,
  lossPoints,
  gradientNormPoints,
}: {
  rewardPoints: Array<{ step: number; value: number }>;
  rolloutPoints: Array<{ step: number; value: number }>;
  learningRatePoints: Array<{ step: number; value: number }>;
  klPoints: Array<{ step: number; value: number }>;
  entropyPoints: Array<{ step: number; value: number }>;
  clipPoints: Array<{ step: number; value: number }>;
  lossPoints: Array<{ step: number; value: number }>;
  gradientNormPoints: Array<{ step: number; value: number }>;
}) {
  return (
    <div className="training-run-metrics">
      <div className="training-metric-chart-grid three">
        <MetricChartCard
          format={compactNumber}
          label="Reward"
          points={rewardPoints}
        />
        <MetricChartCard
          axisLabel="Rollout"
          format={compactNumber}
          label="Rollout reward"
          points={rolloutPoints}
        />
        <MetricChartCard
          format={scientificNumber}
          label="Learning rate"
          points={learningRatePoints}
        />
        {lossPoints.length ? (
          <MetricChartCard format={compactNumber} label="Optimizer loss" points={lossPoints} />
        ) : null}
        {klPoints.length ? (
          <MetricChartCard format={compactNumber} label="KL divergence" points={klPoints} />
        ) : null}
        {entropyPoints.length ? (
          <MetricChartCard format={compactNumber} label="Policy entropy" points={entropyPoints} />
        ) : null}
        {clipPoints.length ? (
          <MetricChartCard format={percent} label="Clip fraction" points={clipPoints} />
        ) : null}
        {gradientNormPoints.length ? (
          <MetricChartCard format={compactNumber} label="Gradient norm" points={gradientNormPoints} />
        ) : null}
      </div>
    </div>
  );
}

function MetricChartCard({
  label,
  points,
  format,
  axisLabel = "Optimizer step",
}: {
  label: string;
  points: Array<{ step: number; value: number }>;
  format: (value: number) => string;
  axisLabel?: string;
}) {
  return (
    <section className="training-metric-chart-card">
      <header>
        <h4>{label}</h4>
        <span>{points.length} {points.length === 1 ? "point" : "points"}</span>
      </header>
      {points.length ? (
        <MetricLineChart
          axisLabel={axisLabel}
          format={format}
          label={label}
          points={points}
        />
      ) : (
        <div className="training-metric-chart-empty">Not recorded</div>
      )}
    </section>
  );
}

function MetricLineChart({
  label,
  points,
  format,
  axisLabel,
}: {
  label: string;
  points: Array<{ step: number; value: number }>;
  format: (value: number) => string;
  axisLabel: string;
}) {
  const width = 760;
  const height = 270;
  const padding = { top: 20, right: 20, bottom: 58, left: 64 };
  const values = points.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || Math.max(Math.abs(rawMax) * 0.1, 1e-9);
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.08;
  const firstStep = points[0]?.step ?? 0;
  const lastPointStep = points.at(-1)?.step ?? firstStep + 1;
  const stepSpan = Math.max(1, lastPointStep - firstStep);
  const plotRight = width - padding.right;
  const x = (step: number) =>
    points.length === 1
      ? (padding.left + plotRight) / 2
      : padding.left +
        ((step - firstStep) / stepSpan) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.step).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const chartBottom = height - padding.bottom;
  const areaPath = points.length > 1
    ? `${path} L${x(lastPointStep).toFixed(2)},${chartBottom} L${x(firstStep).toFixed(2)},${chartBottom} Z`
    : "";
  const pointLabel =
    axisLabel !== "Optimizer step"
      ? axisLabel
      : label === "Learning rate"
        ? "Update"
        : "Step";
  return (
    <figure className="training-line-chart" aria-label={`${label} by ${axisLabel.toLowerCase()}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`metric-${label.replaceAll(" ", "-")}`}>
        <title id={`metric-${label.replaceAll(" ", "-")}`}>{`${label} by ${axisLabel.toLowerCase()}`}</title>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const lineY = padding.top + ratio * (height - padding.top - padding.bottom);
          const value = max - ratio * (max - min);
          return <g key={ratio}><line className="training-chart-grid" x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY}/><text className="training-chart-label" x={padding.left - 10} y={lineY + 4} textAnchor="end">{format(value)}</text></g>;
        })}
        <line className="training-chart-axis" x1={padding.left} x2={width - padding.right} y1={height - padding.bottom} y2={height - padding.bottom}/>
        <path className="training-chart-area" d={areaPath}/>
        <path className="training-chart-line" d={path}/>
        {points.map((point) => <circle key={`${point.step}-${point.value}`} className="training-chart-point" cx={x(point.step)} cy={y(point.value)} r={points.length === 1 ? "4.5" : "3"}><title>{`${pointLabel} ${point.step}: ${format(point.value)}`}</title></circle>)}
        <text className="training-chart-label" x={x(firstStep)} y={height - 34} textAnchor="middle">{firstStep}</text>
        {points.length > 1 ? <text className="training-chart-label" x={plotRight} y={height - 34} textAnchor="middle">{lastPointStep}</text> : null}
        <text className="training-chart-label axis-title" x={(padding.left + width - padding.right) / 2} y={height - 9} textAnchor="middle">{axisLabel}</text>
      </svg>
    </figure>
  );
}

function rolloutRewardPoints(
  events: TrainingRunDetail["events"],
): Array<{ step: number; value: number }> {
  return events.flatMap((event) => {
    if (
      event.type !== "metric" ||
      event.payload.metricKind !== "rollout_trajectory"
    ) {
      return [];
    }
    const step = finiteNumber(event.payload.rolloutIndex);
    const value = finiteNumber(event.payload.reward);
    return step == null || value == null ? [] : [{ step, value }];
  });
}

function managedTelemetryPoints(
  events: TrainingRunDetail["events"],
): Map<string, Array<{ step: number; value: number }>> {
  const byMetric = new Map<string, Array<{ step: number; value: number }>>();
  for (const event of events) {
    if (event.type !== "metric" || event.payload.metricKind !== "managed_telemetry") continue;
    const metricId = typeof event.payload.metricId === "string" ? event.payload.metricId : null;
    const value = finiteNumber(event.payload.value);
    const step = finiteNumber(event.payload.step) ?? event.sequence;
    if (!metricId || value == null) continue;
    const points = byMetric.get(metricId) ?? [];
    points.push({ step, value });
    byMetric.set(metricId, points);
  }
  return byMetric;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function MetricFact({ label, value }: { label: string; value: string | number | null }) {
  return <div><span>{label}</span><strong>{value ?? "Not recorded"}</strong></div>;
}

function finalSummary(detail: TrainingRunDetail): Record<string, number> {
  const event = [...detail.events].reverse().find((candidate) => candidate.type === "metric" && candidate.payload.metricKind !== "sft_step" && (typeof candidate.payload.trainLoss === "number" || typeof candidate.payload.steps === "number"));
  return Object.fromEntries(Object.entries(event?.payload ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function lastStep(metrics: SftStepMetric[]): string | null {
  const last = metrics.at(-1);
  return last ? `${last.step} of ${last.maxSteps}` : null;
}

function uniqueStepMetrics(metrics: SftStepMetric[]): SftStepMetric[] {
  const latestByStep = new Map<number, SftStepMetric>();
  for (const metric of metrics) latestByStep.set(metric.step, metric);
  return [...latestByStep.values()].sort((left, right) => left.step - right.step);
}

function uniquePolicyMetrics(
  metrics: PolicyOptimizationMetric[],
): PolicyOptimizationMetric[] {
  const latestByStep = new Map<number, PolicyOptimizationMetric>();
  for (const metric of metrics) latestByStep.set(metric.step, metric);
  return [...latestByStep.values()].sort((left, right) => left.step - right.step);
}

function peakMemory(metrics: SftStepMetric[]): string | null {
  const values = metrics.flatMap((metric) => metric.memoryBytes == null ? [] : [metric.memoryBytes]);
  return values.length ? bytes(Math.max(...values)) : null;
}

function compactNumber(value: number) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value); }
function scientificNumber(value: number) { return value === 0 ? "0" : value.toExponential(2); }
function percent(value: number) { return `${(value * 100).toFixed(1)}%`; }
function bytes(value: number) { return `${(value / (1024 ** 3)).toFixed(2)} GB`; }
