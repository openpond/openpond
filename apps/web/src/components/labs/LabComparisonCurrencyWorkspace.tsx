import { useMemo, useState } from "react";
import type {
  ModelComparisonSeries,
  ModelComparisonSeriesEntry,
  ModelCurrencySnapshot,
  TrainingStateResponse,
} from "@openpond/contracts";

import { LabStatusBadge } from "./LabStatusBadge";

export function LabComparisonCurrencyWorkspace({
  entries,
  onOpenEvaluation,
  series,
  state,
}: {
  entries: ModelComparisonSeriesEntry[];
  onOpenEvaluation: (id: string) => void;
  series: ModelComparisonSeries;
  state: TrainingStateResponse;
}) {
  const snapshots = useMemo(() => latestSnapshots(state, series.id), [series.id, state]);
  const latest = snapshots.at(-1) ?? null;
  const [selectedTask, setSelectedTask] = useState<{ entryId: string; key: string } | null>(null);
  const selectedSnapshot = selectedTask ? snapshots.find((snapshot) => snapshot.entryId === selectedTask.entryId) ?? null : null;
  const selectedMatch = selectedSnapshot?.matches.find((match) => match.key === selectedTask?.key) ?? null;
  if (!series.benchmarkProtocol) return null;

  return <>
    <section className="training-detail-section labs-currency-workspace">
      <div className="labs-project-trends-heading"><div><h2>Model currency</h2><p>Evidence state is computed from immutable matched attempts. It never advances, holds, or promotes a release.</p></div>{latest ? <LabStatusBadge label={evidenceStateLabel(latest.evidenceState)} value={latest.evidenceState} /> : <span>Awaiting measurements</span>}</div>
      {latest ? <>
        <div className="labs-currency-summary-grid">
          <CurrencyMetric label="Known issue coverage" value={percent(latest.metrics.knownIssueCoverage)} hint="Correction cases absorbed" />
          <CurrencyMetric label="Family generalization" value={percent(latest.metrics.issueFamilyGeneralization)} hint="Sibling cases retained" />
          <CurrencyMetric label="Behavioral retention" value={percent(latest.metrics.behavioralRetention)} hint="Prior behavior preserved" />
          <CurrencyMetric label="Frontier delta" value={points(latest.metrics.frontierStrictDelta)} hint="Strict success points" />
          <CurrencyMetric label="Matched attempts" value={formatInteger(latest.statistics.matchedAttemptCount)} hint={latest.statistics.exactPairedBinaryPValue === null ? "p unavailable" : `exact p ${latest.statistics.exactPairedBinaryPValue.toFixed(4)}`} />
          <CurrencyMetric label="Evidence reasons" value={latest.evidenceReasons.length || "None"} hint={latest.evidenceReasons.join(" · ") || "All required evidence satisfied"} />
        </div>
        <div className="labs-currency-decision-separation">
          <div><small>Computed evidence state</small><strong>{evidenceStateLabel(latest.evidenceState)}</strong><span>{latest.projectedAt}</span></div>
          <span aria-hidden="true">≠</span>
          <div><small>Operator decision</small><strong>{entryDecision(entries, latest.entryId)}</strong><span>Advance/hold is recorded separately</span></div>
        </div>
        <div className="labs-comparison-evidence-grid">
          <EvidenceCard title="Release criteria" rows={[
            ["All attempts terminal", yesNo(latest.criteria.allRequiredAttemptsTerminal)],
            ["Critical correction", percent(latest.criteria.criticalCorrectionPassRate)],
            ["Sibling verification", percent(latest.criteria.siblingPassRate)],
            ["Retention", percent(latest.criteria.behavioralRetentionRate)],
            ["Retained regression", points(latest.criteria.retainedRegressionPoints)],
            ["Critical prior regressions", String(latest.criteria.criticalPriorRegressionCount)],
          ]} />
          <EvidenceCard title="Evaluation efficiency" rows={[
            ["Total tokens", formatInteger(latest.efficiency.totalTokens)],
            ["Tokens / success", decimal(latest.efficiency.tokensPerSuccess, 1)],
            ["Throughput / hour", decimal(latest.efficiency.throughputPerHour, 1)],
            ["Latency", duration(latest.efficiency.latencyMs)],
            ["Evaluation GPU", latest.efficiency.gpuSeconds === null ? "Unavailable" : `${latest.efficiency.gpuSeconds.toFixed(1)}s`],
            ["Observed cost", latest.efficiency.costUsd === null ? "Unavailable" : `$${latest.efficiency.costUsd.toFixed(3)}`],
          ]} />
          <EvidenceCard title="Pinned invariants" rows={[
            ["Application", ref(latest.invariants.application)],
            ["Harness", ref(latest.invariants.harness)],
            ["Runtime", ref(latest.invariants.runtime)],
            ["Grader", ref(latest.invariants.grader)],
            ["Tool schema", ref(latest.invariants.toolSchema)],
            ["Auto-refiner", latest.invariants.autoRefinerEnabled ? "Enabled" : "Disabled"],
          ]} />
        </div>
      </> : <div className="training-run-placeholder">No currency snapshot exists yet. Queueing or training alone does not create one; matched parent and candidate Evaluation receipts are required.</div>}
    </section>
    <CohortHeatmap entries={entries} onOpenEvaluation={onOpenEvaluation} series={series} snapshots={snapshots} />
    <IssueLedger onSelectTask={(entryId, key) => setSelectedTask({ entryId, key })} snapshots={snapshots} />
    <EfficiencyHistory entries={entries} snapshots={snapshots} />
    {selectedSnapshot && selectedMatch ? <TaskEvidence
      entry={entries.find((entry) => entry.id === selectedSnapshot.entryId) ?? null}
      match={selectedMatch}
      onClose={() => setSelectedTask(null)}
      onOpenEvaluation={onOpenEvaluation}
      snapshot={selectedSnapshot}
    /> : null}
  </>;
}

function CohortHeatmap({ entries, onOpenEvaluation, series, snapshots }: { entries: ModelComparisonSeriesEntry[]; onOpenEvaluation: (id: string) => void; series: ModelComparisonSeries; snapshots: ModelCurrencySnapshot[] }) {
  const panels = series.benchmarkProtocol!.panels.filter((panel) => panel.role !== "training_eligible");
  return <section className="training-detail-section"><div className="labs-project-trends-heading"><div><h2>Cohort heatmap</h2><p>Every populated cell links to an exact Evaluation Run, Taskset release, and sealed panel.</p></div><span>{panels.length} evaluation panels</span></div><div className="training-table-wrap"><table className="training-data-table labs-currency-heatmap"><thead><tr><th>Release</th>{panels.map((panel) => <th key={panel.id}>{panel.passLabel ?? title(panel.role)}<small>{panel.passLabel ? title(panel.role) : null}</small></th>)}</tr></thead><tbody>{entries.map((entry) => {
    const snapshot = snapshots.find((candidate) => candidate.entryId === entry.id) ?? null;
    return <tr key={entry.id}><td><strong>{entry.label}</strong><small>{snapshot ? evidenceStateLabel(snapshot.evidenceState) : "No snapshot"}</small></td>{panels.map((panel) => {
      const metric = snapshot?.panels.find((candidate) => candidate.panelId === panel.id) ?? null;
      const link = [...entry.evaluations].reverse().find((candidate) => candidate.panelId === panel.id) ?? null;
      return <td className={heatClass(metric?.strictSuccess ?? null)} key={panel.id}>{link ? <button className="labs-version-row-button" type="button" onClick={() => onOpenEvaluation(link.evaluationRunId)}><strong>{percent(metric?.strictSuccess ?? null)}</strong><small>{metric ? `${metric.passed}/${metric.available} · n=${metric.attempted}` : "Measuring"}</small></button> : <span>—</span>}</td>;
    })}</tr>;
  })}{!entries.length ? <tr><td colSpan={panels.length + 1}>No releases are materialized yet.</td></tr> : null}</tbody></table></div></section>;
}

function IssueLedger({ onSelectTask, snapshots }: { onSelectTask: (entryId: string, key: string) => void; snapshots: ModelCurrencySnapshot[] }) {
  const families = new Map<string, { fixed: number; retained: number; regressed: number; unresolved: number; unavailable: number; latest: ModelCurrencySnapshot; exampleKey: string }>();
  for (const snapshot of snapshots) for (const match of snapshot.matches) {
    const current = families.get(match.issueFamilyId) ?? { fixed: 0, retained: 0, regressed: 0, unresolved: 0, unavailable: 0, latest: snapshot, exampleKey: match.key };
    current[match.classification] += 1;
    current.latest = snapshot;
    current.exampleKey = match.key;
    families.set(match.issueFamilyId, current);
  }
  return <section className="training-detail-section"><div className="labs-project-trends-heading"><div><h2>Issue-family ledger</h2><p>Corrections and sibling verification stay grouped by issue family; task-level matched evidence remains one click away.</p></div><span>{families.size} measured families</span></div><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Issue family</th><th>Fixed</th><th>Retained</th><th>Regressed</th><th>Unresolved</th><th>Unavailable</th><th>Evidence</th></tr></thead><tbody>{[...families.entries()].map(([familyId, counts]) => <tr key={familyId}><td><strong>{familyId}</strong><small>{counts.latest.passLabel}</small></td><td>{counts.fixed}</td><td>{counts.retained}</td><td>{counts.regressed}</td><td>{counts.unresolved}</td><td>{counts.unavailable}</td><td><button className="training-button secondary" type="button" onClick={() => onSelectTask(counts.latest.entryId, counts.exampleKey)}>Open task evidence</button></td></tr>)}{!families.size ? <tr><td colSpan={7}>The sealed issue ledger is ready; matched task outcomes appear after Evaluation receipts project.</td></tr> : null}</tbody></table></div></section>;
}

function EfficiencyHistory({ entries, snapshots }: { entries: ModelComparisonSeriesEntry[]; snapshots: ModelCurrencySnapshot[] }) {
  return <section className="training-detail-section"><div className="labs-project-trends-heading"><div><h2>Efficiency by release</h2><p>Resource use is receipt-backed and shown beside quality, never substituted for it.</p></div></div><div className="labs-efficiency-history">{snapshots.map((snapshot) => <article className="labs-resource-card" key={snapshot.id}><header><strong>{entries.find((entry) => entry.id === snapshot.entryId)?.label ?? snapshot.passLabel}</strong><small>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(snapshot.projectedAt))}</small></header><dl><div><dt>Tokens / success</dt><dd>{decimal(snapshot.efficiency.tokensPerSuccess, 0)}</dd></div><div><dt>Throughput</dt><dd>{decimal(snapshot.efficiency.throughputPerHour, 1)}/h</dd></div><div><dt>GPU</dt><dd>{snapshot.efficiency.gpuSeconds === null ? "—" : `${snapshot.efficiency.gpuSeconds.toFixed(0)}s`}</dd></div><div><dt>Cost</dt><dd>{snapshot.efficiency.costUsd === null ? "—" : `$${snapshot.efficiency.costUsd.toFixed(2)}`}</dd></div></dl></article>)}{!snapshots.length ? <div className="training-run-placeholder">Efficiency appears with the first immutable currency snapshot.</div> : null}</div></section>;
}

function TaskEvidence({ entry, match, onClose, onOpenEvaluation, snapshot }: { entry: ModelComparisonSeriesEntry | null; match: ModelCurrencySnapshot["matches"][number]; onClose: () => void; onOpenEvaluation: (id: string) => void; snapshot: ModelCurrencySnapshot }) {
  return <section className="training-detail-section labs-task-evidence-page"><div className="labs-project-trends-heading"><div><h2>Matched task evidence · {match.taskId}</h2><p>{entry?.label ?? snapshot.passLabel} · {match.issueFamilyId} · seed {match.seed} · repetition {match.repetition + 1}</p></div><button className="training-button secondary" type="button" onClick={onClose}>Close task</button></div><div className="labs-currency-summary-grid"><CurrencyMetric label="Classification" value={title(match.classification)} hint={`Panel ${match.panelId}`} /><CurrencyMetric label="Parent outcome" value={outcome(match.parentPassed)} hint={snapshot.parent.kind === "base_model" ? snapshot.parent.id : snapshot.parent.id} /><CurrencyMetric label="Candidate outcome" value={outcome(match.candidatePassed)} hint={snapshot.candidate.id} /></div><div className="labs-matched-attempt-grid"><AttemptReference label="Parent attempt" onOpenEvaluation={onOpenEvaluation} value={match.parentAttempt} /><AttemptReference label="Candidate attempt" onOpenEvaluation={onOpenEvaluation} value={match.candidateAttempt} /></div></section>;
}

function AttemptReference({ label, onOpenEvaluation, value }: { label: string; onOpenEvaluation: (id: string) => void; value: ModelCurrencySnapshot["matches"][number]["parentAttempt"] }) {
  if (!value) return <article className="labs-resource-card"><header><strong>{label}</strong></header><p className="labs-detail-copy">Unavailable</p></article>;
  return <article className="labs-resource-card"><header><strong>{label}</strong><button className="training-button secondary" type="button" onClick={() => onOpenEvaluation(value.evaluationRunId)}>Open Evaluation</button></header><dl className="labs-comparison-evidence-list"><div><dt>Run</dt><dd className="labs-mono-value">{value.evaluationRunId}</dd></div><div><dt>Attempt</dt><dd className="labs-mono-value">{value.attemptKey}</dd></div><div><dt>Artifact</dt><dd className="labs-mono-value">{value.artifactPath}</dd></div><div><dt>Pointer</dt><dd className="labs-mono-value">{value.jsonPointer}</dd></div><div><dt>Transcript hash</dt><dd className="labs-mono-value">{value.transcriptHash ?? "Unavailable"}</dd></div><div><dt>Trace hash</dt><dd className="labs-mono-value">{value.traceHash ?? "Unavailable"}</dd></div></dl></article>;
}

function latestSnapshots(state: TrainingStateResponse, seriesId: string): ModelCurrencySnapshot[] {
  const byEntry = new Map<string, ModelCurrencySnapshot>();
  for (const snapshot of state.modelCurrencySnapshots.filter((candidate) => candidate.seriesId === seriesId)) {
    const current = byEntry.get(snapshot.entryId);
    if (!current || current.projectedAt < snapshot.projectedAt) byEntry.set(snapshot.entryId, snapshot);
  }
  return [...byEntry.values()].sort((left, right) => left.projectedAt.localeCompare(right.projectedAt));
}

function CurrencyMetric({ hint, label, value }: { hint: string; label: string; value: string | number }) { return <article className="labs-resource-card labs-currency-metric"><small>{label}</small><strong>{value}</strong><span>{hint}</span></article>; }
function EvidenceCard({ rows, title: cardTitle }: { rows: Array<[string, string]>; title: string }) { return <article className="labs-resource-card"><header><strong>{cardTitle}</strong></header><dl className="labs-comparison-evidence-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></article>; }
function evidenceStateLabel(value: ModelCurrencySnapshot["evidenceState"]) { return value === "up_to_date" ? "Up to date" : value === "needs_attention" ? "Needs attention" : "Measuring"; }
function entryDecision(entries: ModelComparisonSeriesEntry[], id: string) { const entry = entries.find((candidate) => candidate.id === id); return entry?.decision ? title(entry.decision.disposition) : "Awaiting review"; }
function percent(value: number | null) { return value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`; }
function points(value: number | null) { return value === null ? "Unavailable" : `${value > 0 ? "+" : ""}${value.toFixed(1)} pts`; }
function decimal(value: number | null, digits: number) { return value === null ? "Unavailable" : value.toFixed(digits); }
function formatInteger(value: number) { return new Intl.NumberFormat().format(value); }
function duration(value: number) { return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`; }
function yesNo(value: boolean) { return value ? "Yes" : "No"; }
function ref(value: { id: string; contentHash: string }) { return `${value.id} · ${value.contentHash.slice(0, 12)}`; }
function outcome(value: boolean | null) { return value === null ? "Unavailable" : value ? "Passed" : "Failed"; }
function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function heatClass(value: number | null) { return value === null ? "empty" : value >= 0.8 ? "high" : value >= 0.5 ? "medium" : "low"; }
