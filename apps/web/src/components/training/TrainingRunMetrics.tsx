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
  const summary = detail ? finalSummary(detail) : {};

  if (loading && !detail) return <div className="training-run-placeholder">Loading training metrics…</div>;
  if (error && !detail) return <div className="training-run-placeholder">Training metrics are unavailable.</div>;
  if (!detail) return <div className="training-run-placeholder">Select a training run to inspect its metrics.</div>;
  if (policyMetrics.length) {
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
          <MetricFact
            label="Value loss"
            value={latest.valueLoss == null ? null : compactNumber(latest.valueLoss)}
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
            <MetricLineChart
              label={activePolicy.label}
              points={policyPoints}
              format={activePolicy.format}
            />
          </>
        ) : null}
      </div>
    );
  }
  const rft = detail.job.metadata.trainingMethod === "grpo";
  const rewardValues = stepMetrics.flatMap((metric) => metric.reward == null ? [] : [metric.reward]);
  const lossValues = stepMetrics.flatMap((metric) => metric.loss == null ? [] : [metric.loss]);

  return (
    <div className="training-run-metrics">
      <div className="training-metric-summary">
        <MetricFact
          label={rft ? "Optimizer updates" : "Steps"}
          value={rft
            ? optimizerUpdates(detail, stepMetrics)
            : summary.steps ?? lastStep(stepMetrics)}
        />
        {rft ? (
          <>
            <MetricFact label="Latest reward" value={rewardValues.length ? compactNumber(rewardValues.at(-1)!) : null} />
            <MetricFact label="Best reward" value={rewardValues.length ? compactNumber(Math.max(...rewardValues)) : null} />
            <MetricFact label="Recorded points" value={rewardValues.length || null} />
          </>
        ) : (
          <>
            <MetricFact label="Final loss" value={summary.trainLoss == null ? lossValues.at(-1) == null ? null : compactNumber(lossValues.at(-1)!) : compactNumber(summary.trainLoss)} />
            <MetricFact label="Peak memory" value={peakMemory(detail.stepMetrics)} />
            <MetricFact label="Adapter parameters" value={summary.adapterParameterCount == null ? null : summary.adapterParameterCount.toLocaleString()} />
          </>
        )}
      </div>
      {available.length ? (
        <>
          <div className="training-metric-tabs" role="tablist" aria-label="Training metrics">
            {available.map((metric) => <button key={metric.key} type="button" role="tab" aria-selected={metric.key === active.key} className={metric.key === active.key ? "active" : ""} onClick={() => setRequestedMetric(metric.key)}>{metric.label}</button>)}
          </div>
          <MetricLineChart label={active.label} points={points} format={active.format} />
        </>
      ) : <div className="training-run-placeholder">This earlier run recorded its final result but not per-step Trainer logs.</div>}
    </div>
  );
}

function MetricLineChart({ label, points, format }: { label: string; points: Array<{ step: number; value: number }>; format: (value: number) => string }) {
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
  const x = (step: number) => padding.left + ((step - firstStep) / stepSpan) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.step).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  return (
    <figure className="training-line-chart" aria-label={`${label} by optimizer step`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`metric-${label.replaceAll(" ", "-")}`}>
        <title id={`metric-${label.replaceAll(" ", "-")}`}>{`${label} by optimizer step`}</title>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const lineY = padding.top + ratio * (height - padding.top - padding.bottom);
          const value = max - ratio * (max - min);
          return <g key={ratio}><line className="training-chart-grid" x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY}/><text className="training-chart-label" x={padding.left - 10} y={lineY + 4} textAnchor="end">{format(value)}</text></g>;
        })}
        <line className="training-chart-axis" x1={padding.left} x2={width - padding.right} y1={height - padding.bottom} y2={height - padding.bottom}/>
        <path className="training-chart-line" d={path}/>
        {points.map((point) => <circle key={`${point.step}-${point.value}`} className="training-chart-point" cx={x(point.step)} cy={y(point.value)} r="3"><title>{`Step ${point.step}: ${format(point.value)}`}</title></circle>)}
        <text className="training-chart-label" x={padding.left} y={height - 34} textAnchor="middle">{firstStep}</text>
        <text className="training-chart-label" x={width - padding.right} y={height - 34} textAnchor="middle">{lastPointStep}</text>
        <text className="training-chart-label axis-title" x={(padding.left + width - padding.right) / 2} y={height - 9} textAnchor="middle">Optimizer step</text>
      </svg>
    </figure>
  );
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

function optimizerUpdates(
  detail: TrainingRunDetail,
  metrics: SftStepMetric[],
): number | null {
  const observed = detail.job.metadata.optimizerUpdatesObserved;
  if (typeof observed === "number" && Number.isFinite(observed)) {
    return Math.max(0, observed);
  }
  const lastStep = metrics.at(-1)?.step ?? 0;
  return lastStep || null;
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
