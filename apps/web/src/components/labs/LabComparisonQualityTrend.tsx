import type {
  ModelComparisonBenchmarkReceipt,
  ModelComparisonSeries,
  ModelComparisonSeriesEntry,
  ModelRun,
  TrainingStateResponse,
} from "@openpond/contracts";

type Metric = "deterministic" | "judge";

type TrendPoint = {
  id: string;
  entryId: string;
  label: string;
  date: string;
  value: number;
  lower: number;
  upper: number;
  runId: string;
  comparisonCount: number;
  wins: number | null;
  ties: number | null;
  losses: number | null;
  acceptedValue: number | null;
};

type ReferenceLine = {
  id: string;
  label: string;
  value: number;
  runId: string;
  kind: "base" | "master" | "frontier";
};

export function LabComparisonQualityTrend({
  entries,
  onOpenEvaluation,
  series,
  state,
}: {
  entries: ModelComparisonSeriesEntry[];
  onOpenEvaluation: (runId: string) => void;
  series: ModelComparisonSeries;
  state: TrainingStateResponse;
}) {
  const deterministic = trendData("deterministic", entries, series, state);
  const judge = trendData("judge", entries, series, state);
  const frozenTaskset = state.tasksets.find((taskset) =>
    taskset.id === series.evaluationTasksets.frozenFinal.id
    && taskset.revision === series.evaluationTasksets.frozenFinal.revision
    && taskset.contentHash === series.evaluationTasksets.frozenFinal.contentHash,
  ) ?? state.modelTasksets.find((taskset) =>
    taskset.id === series.evaluationTasksets.frozenFinal.id
    && taskset.revision === series.evaluationTasksets.frozenFinal.revision
    && taskset.contentHash === series.evaluationTasksets.frozenFinal.contentHash,
  ) ?? null;

  return <section className="training-detail-section labs-quality-trend-section">
    <div className="labs-project-trends-heading">
      <div>
        <h2>Quality history</h2>
        <p>Candidate points, the accepted-head step line, base/Master/frontier references, and paired 95% confidence intervals share the same frozen panel.</p>
      </div>
      <span>{frozenTaskset ? `${frozenTaskset.tasks.length} frozen tasks` : "Frozen panel unavailable"}</span>
    </div>
    <div className="labs-quality-trend-grid">
      <QualityChart
        data={deterministic}
        empty="Run the sealed frozen panel to populate deterministic success. Training reward is not substituted."
        metric="deterministic"
        onOpenEvaluation={onOpenEvaluation}
        title="Strict task success"
      />
      <QualityChart
        data={judge}
        empty="Run the pinned calibrated judge over the same completed attempts to populate judge quality."
        metric="judge"
        onOpenEvaluation={onOpenEvaluation}
        title="Independent judge score"
      />
    </div>
  </section>;
}

function QualityChart({
  data,
  empty,
  metric,
  onOpenEvaluation,
  title,
}: {
  data: { points: TrendPoint[]; references: ReferenceLine[] };
  empty: string;
  metric: Metric;
  onOpenEvaluation: (runId: string) => void;
  title: string;
}) {
  if (!data.points.length && !data.references.length) {
    return <article className="labs-resource-card labs-quality-chart-card">
      <header><strong>{title}</strong><small>{metric === "judge" ? "0–100 calibrated scale" : "0–100% pass rate"}</small></header>
      <div className="training-run-placeholder">{empty}</div>
    </article>;
  }
  const width = 720;
  const height = 280;
  const left = 48;
  const right = 28;
  const top = 22;
  const bottom = 48;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const x = (index: number) => left + (data.points.length <= 1 ? chartWidth / 2 : (index / (data.points.length - 1)) * chartWidth);
  const y = (value: number) => top + chartHeight - (clamp(value) / 100) * chartHeight;
  const path = data.points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ");
  const acceptedPath = stepPath(data.points, x, y);

  return <article className="labs-resource-card labs-quality-chart-card">
    <header><strong>{title}</strong><small>{metric === "judge" ? "0–100 calibrated scale" : "0–100% pass rate"}</small></header>
    <svg aria-label={`${title} by release date`} role="img" viewBox={`0 0 ${width} ${height}`}>
      {[0, 25, 50, 75, 100].map((tick) => <g key={tick}>
        <line className="labs-quality-grid-line" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />
        <text className="labs-quality-axis-label" x={left - 9} y={y(tick) + 4} textAnchor="end">{tick}</text>
      </g>)}
      {data.references.map((reference) => <g key={reference.id}>
        <line className={`labs-quality-reference ${reference.kind}`} x1={left} x2={width - right} y1={y(reference.value)} y2={y(reference.value)} />
        <text className={`labs-quality-reference-label ${reference.kind}`} x={width - right} y={y(reference.value) - 6} textAnchor="end">{reference.label} · {reference.value.toFixed(1)}</text>
      </g>)}
      {data.points.length > 1 ? <path className="labs-quality-series-line" d={path} fill="none" /> : null}
      {acceptedPath ? <path className="labs-quality-accepted-line" d={acceptedPath} fill="none" /> : null}
      {data.points.map((point, index) => <g className="labs-quality-point" key={point.id} onClick={() => onOpenEvaluation(point.runId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpenEvaluation(point.runId); }} role="button" tabIndex={0}>
        <line className="labs-quality-error-bar" x1={x(index)} x2={x(index)} y1={y(point.upper)} y2={y(point.lower)} />
        <line className="labs-quality-error-bar" x1={x(index) - 5} x2={x(index) + 5} y1={y(point.upper)} y2={y(point.upper)} />
        <line className="labs-quality-error-bar" x1={x(index) - 5} x2={x(index) + 5} y1={y(point.lower)} y2={y(point.lower)} />
        <circle cx={x(index)} cy={y(point.value)} r="5" />
        <text className="labs-quality-point-value" x={x(index)} y={y(point.value) - 12} textAnchor="middle">{point.value.toFixed(1)}</text>
        <text className="labs-quality-axis-label" x={x(index)} y={height - 25} textAnchor="middle">{point.label}</text>
        <text className="labs-quality-date-label" x={x(index)} y={height - 9} textAnchor="middle">{shortDate(point.date)}</text>
      </g>)}
    </svg>
    <div className="labs-quality-legend"><span><i className="candidate" />Candidate</span><span><i className="accepted" />Accepted head</span>{data.references.map((reference) => <button key={reference.id} type="button" onClick={() => onOpenEvaluation(reference.runId)}><i className={reference.kind} />{reference.label} · {reference.value.toFixed(1)}</button>)}</div>
    {metric === "judge" && data.points.length ? <div className="labs-quality-judge-evidence">
      {data.points.map((point) => <button key={point.id} type="button" onClick={() => onOpenEvaluation(point.runId)}>
        <strong>{point.label}</strong>
        <span>{point.wins}/{point.ties}/{point.losses} win/tie/loss · n={point.comparisonCount}</span>
      </button>)}
    </div> : null}
  </article>;
}

function trendData(
  metric: Metric,
  entries: ModelComparisonSeriesEntry[],
  series: ModelComparisonSeries,
  state: TrainingStateResponse,
): { points: TrendPoint[]; references: ReferenceLine[] } {
  const frozen = series.evaluationTasksets.frozenFinal;
  const receiptByRun = new Map(state.modelRuns.flatMap((run) => {
    const receipt = comparisonReceipt(run);
    return receipt ? [[run.id, { receipt, run }] as const] : [];
  }));
  const points: TrendPoint[] = entries.flatMap((entry) => {
    const links = entry.evaluations.filter((link) =>
      link.cohortRole === "frozen_final"
      && link.taskset.id === frozen.id
      && link.taskset.revision === frozen.revision
      && link.taskset.contentHash === frozen.contentHash,
    );
    const resolved = [...links].reverse().map((link) => receiptByRun.get(link.evaluationRunId) ?? null).find(Boolean) ?? null;
    if (!resolved) return [];
    const value = metricValue(metric, resolved.receipt);
    if (!value) return [];
    return [{
      id: `${entry.id}:${metric}`,
      entryId: entry.id,
      label: entry.label,
      date: resolved.run.completedAt ?? entry.completedAt ?? entry.createdAt,
      value: value.value,
      lower: value.lower,
      upper: value.upper,
      runId: resolved.run.id,
      comparisonCount: value.comparisonCount,
      wins: value.wins,
      ties: value.ties,
      losses: value.losses,
      acceptedValue: null,
    }];
  });
  let acceptedValue: number | null = null;
  for (const point of points) {
    const entry = entries.find((candidate) => candidate.id === point.entryId);
    if (entry?.decision?.disposition === "advance" || entry?.status === "accepted") acceptedValue = point.value;
    point.acceptedValue = acceptedValue;
  }
  const linkedRunIds = new Set(entries.flatMap((entry) => entry.evaluations.map((link) => link.evaluationRunId)));
  const references = state.modelRuns.flatMap((run): ReferenceLine[] => {
    const receipt = comparisonReceipt(run);
    if (!receipt || linkedRunIds.has(run.id) || receipt.taskset.id !== frozen.id || receipt.taskset.revision !== frozen.revision || receipt.taskset.contentHash !== frozen.contentHash) return [];
    const value = metricValue(metric, receipt);
    if (!value) return [];
    const kind = receipt.target.kind === "external_reference" ? "frontier" : receipt.target.kind === "base_model" ? "base" : "master";
    return [{ id: `${run.id}:${metric}`, label: receipt.target.label, value: value.value, runId: run.id, kind }];
  });
  return { points, references: dedupeReferences(references) };
}

function comparisonReceipt(run: ModelRun): ModelComparisonBenchmarkReceipt | null {
  return run.status === "succeeded" && run.receipt?.schemaVersion === "openpond.modelComparisonBenchmarkReceipt.v1"
    ? run.receipt
    : null;
}

function metricValue(metric: Metric, receipt: ModelComparisonBenchmarkReceipt) {
  if (metric === "judge") {
    const judge = receipt.judge;
    return judge ? { value: judge.score, lower: judge.scoreCi95.lower, upper: judge.scoreCi95.upper, comparisonCount: judge.comparisonCount, wins: judge.wins, ties: judge.ties, losses: judge.losses } : null;
  }
  const passRate = receipt.deterministic.passRate;
  const interval = receipt.deterministic.passRateCi95;
  return passRate === null || !interval ? null : { value: passRate * 100, lower: interval.lower * 100, upper: interval.upper * 100, comparisonCount: receipt.deterministic.completedTaskCount, wins: null, ties: null, losses: null };
}

function dedupeReferences(references: ReferenceLine[]): ReferenceLine[] {
  const latest = new Map<string, ReferenceLine>();
  for (const reference of references) latest.set(`${reference.kind}:${reference.label}`, reference);
  return [...latest.values()];
}

function clamp(value: number) { return Math.max(0, Math.min(100, value)); }
function shortDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)); }
function stepPath(points: TrendPoint[], x: (index: number) => number, y: (value: number) => number): string {
  const segments: string[] = [];
  let previous: { index: number; value: number } | null = null;
  points.forEach((point, index) => {
    if (point.acceptedValue === null) return;
    if (!previous) segments.push(`M${x(index)},${y(point.acceptedValue)}`);
    else segments.push(`L${x(index)},${y(previous.value)} L${x(index)},${y(point.acceptedValue)}`);
    previous = { index, value: point.acceptedValue };
  });
  return segments.join(" ");
}
