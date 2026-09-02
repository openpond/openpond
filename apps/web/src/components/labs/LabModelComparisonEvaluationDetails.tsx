import { useState } from "react";
import type {
  ModelComparisonBenchmarkReceipt,
  ModelRun,
} from "@openpond/contracts";

import { formatDateTime } from "../training/training-model-data";
import { LabAttemptEvidenceDialog, type AttemptEvidencePayload } from "./LabAttemptEvidenceDialog";

type DetailTab = "overview" | "comparison" | "activity";

export function LabModelComparisonEvaluationDetails({
  activeTab,
  receipt,
  run,
  onLoadEvidence,
}: {
  activeTab: DetailTab;
  receipt: ModelComparisonBenchmarkReceipt | null;
  run: ModelRun;
  onLoadEvidence: (input: { runId: string; attemptId: string; kind: "transcript" | "trace" }) => Promise<AttemptEvidencePayload | null>;
}) {
  const [evidence, setEvidence] = useState<{ attemptId: string; kind: "transcript" | "trace" } | null>(null);
  const evaluation = run.evaluation?.benchmarkId === "model-comparison"
    ? run.evaluation
    : null;
  if (!evaluation) return null;

  const progress = run.evaluationProgress;
  const completed = progress?.completedAttempts ?? receipt?.deterministic.completedTaskCount ?? 0;
  const total = progress?.totalAttempts ?? receipt?.deterministic.attemptedTaskCount ?? evaluation.attemptPlan[0].attemptCount;
  const percentComplete = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

  if (activeTab === "overview") {
    return (
      <>
        <section className="training-detail-section">
          <div className="labs-project-trends-heading">
            <div>
              <h2>{receipt ? "Evaluation result" : "Evaluation progress"}</h2>
              <p>The frozen Taskset and grader identity remain fixed for every release in this comparison.</p>
            </div>
            <span>{completed} of {total} tasks</span>
          </div>
          <div className="labs-benchmark-progress">
            <header>
              <h3>{run.status === "running" ? "Running comparison" : titleCase(run.status)}</h3>
              <strong>{percentComplete.toFixed(0)}%</strong>
            </header>
            <div className="labs-benchmark-progress-track" aria-label={`${completed} of ${total} tasks completed`}>
              <span style={{ width: `${percentComplete}%` }} />
            </div>
          </div>
          <dl className="labs-inline-facts">
            <Fact label="Target" value={evaluation.target.label} />
            <Fact label="Target type" value={titleCase(evaluation.target.kind)} />
            <Fact label="Model" value={evaluationTargetLabel(evaluation)} />
            <Fact label="Cohort" value={titleCase(evaluation.attemptPlan[0].split)} />
            <Fact label="Panel" value={evaluation.panel ? `${evaluation.panel.id}${evaluation.panel.passLabel ? ` · ${evaluation.panel.passLabel}` : ""}` : "Legacy cohort"} />
            <Fact label="Taskset release" value={`${run.taskset.id} · r${run.taskset.revision}`} />
            <Fact label="Taskset hash" value={run.taskset.contentHash} />
            <Fact label="Grader" value={`${evaluation.grader.id} · ${evaluation.grader.contentHash}`} />
            <Fact label="Harness" value={run.harnessRelease ? `${run.harnessRelease.id} · ${run.harnessRelease.contentHash}` : "Unavailable"} />
            <Fact label="Protocol" value={evaluation.series ? `${evaluation.series.protocol.id} · r${evaluation.series.protocol.revision}` : "Legacy comparison"} />
            <Fact label="Protocol hash" value={evaluation.series?.protocol.contentHash ?? "Unavailable"} />
            <Fact label="Sampling" value={`${evaluation.seeds.length} seed${evaluation.seeds.length === 1 ? "" : "s"} × ${evaluation.repetitions} repetition${evaluation.repetitions === 1 ? "" : "s"}`} />
            <Fact label="Maximum spend" value={`$${evaluation.maximumSpendUsd.toFixed(2)}`} />
            <Fact label="Started" value={formatDateTime(run.startedAt)} />
            <Fact label="Updated" value={formatDateTime(run.updatedAt)} />
          </dl>
          {receipt ? <dl className="labs-inline-facts">
            <Fact label="Strict success" value={formatPassRate(receipt)} />
            <Fact label="Passed tasks" value={`${receipt.deterministic.passedTaskCount} / ${receipt.deterministic.completedTaskCount}`} />
            <Fact label="Mean grader score" value={receipt.deterministic.meanScore?.toFixed(3) ?? "Unavailable"} />
            <Fact label="Judge score" value={receipt.judge ? `${receipt.judge.score.toFixed(1)} / 100` : "Not run"} />
            <Fact label="Observed spend" value={receipt.usage.observedSpendUsd === null ? "Unavailable" : `$${receipt.usage.observedSpendUsd.toFixed(3)}`} />
            <Fact label="Receipt sealed" value={formatDateTime(receipt.completedAt)} />
            <Fact label="Receipt hash" value={receipt.contentHash} />
            <Fact label="Evidence snapshot" value={`${receipt.evidenceSnapshot.id} · ${receipt.evidenceSnapshot.contentHash}`} />
            <Fact label="Evaluation GPU" value={receipt.usage.evaluationGpuSeconds === null ? "Unavailable" : `${receipt.usage.evaluationGpuSeconds.toFixed(1)}s`} />
          </dl> : null}
          {!receipt && run.status === "running" ? <p className="labs-detail-copy">Aggregate scores and immutable attempt evidence appear as soon as the terminal receipt seals. Progress above is live.</p> : null}
          {run.failure ? <p className="training-banner error">{run.failure}</p> : null}
        </section>
      </>
    );
  }

  if (activeTab === "comparison") {
    return (
      <section className="training-detail-section">
        <h2>Comparable scores</h2>
        {receipt ? <>
          <div className="labs-evaluation-score-row labs-evaluation-score-row-large">
            <div><span>Strict task success</span><strong>{formatPassRate(receipt)}</strong></div>
            <div><span>Independent judge</span><strong>{receipt.judge ? `${receipt.judge.score.toFixed(1)}` : "Not run"}</strong></div>
            <div><span>Completed tasks</span><strong>{receipt.deterministic.completedTaskCount}</strong></div>
          </div>
          <p className="labs-detail-copy">
            Strict success comes from the pinned deterministic grader. The judge score remains separate and is shown only when a calibrated judge receipt exists.
          </p>
        </> : <p className="labs-detail-copy">This run is {run.status}. Comparable scores will appear when its immutable terminal receipt is recorded.</p>}
      </section>
    );
  }

  return (
    <section className="training-detail-section">
      <div className="labs-project-trends-heading">
        <div><h2>Attempt evidence</h2><p>Each task retains its seed, deterministic outcome, hashes, and failure classification.</p></div>
        <span>{receipt?.attempts.length ?? completed} of {total}</span>
      </div>
      {receipt ? <><div className="training-table-wrap">
        <table className="training-data-table">
          <thead><tr><th>Task / attempt</th><th>Seed</th><th>Status</th><th>Passed</th><th>Score</th><th>Judge</th><th>Latency</th><th>Failure</th><th>Evidence</th></tr></thead>
          <tbody>{receipt.attempts.map((attempt) => <tr key={`${attempt.taskId}:${attempt.seed}:${attempt.repetition}`}>
            <td><strong>{attempt.taskId}</strong><small className="labs-mono-value">{attempt.attemptId ?? "No attempt id"}</small></td>
            <td>{attempt.seed}<small>rep {attempt.repetition + 1}</small></td>
            <td>{titleCase(attempt.status)}</td>
            <td>{attempt.passed === null ? "—" : attempt.passed ? "Yes" : "No"}</td>
            <td>{attempt.deterministicScore?.toFixed(3) ?? "—"}</td>
            <td>{attempt.judgeScore === null ? "—" : <>{attempt.judgeScore.toFixed(1)}<small>{attempt.judgePreference ? titleCase(attempt.judgePreference) : null}</small></>}</td>
            <td>{attempt.latencyMs === null ? "—" : `${(attempt.latencyMs / 1_000).toFixed(1)}s`}</td>
            <td>{attempt.failureClass ? titleCase(attempt.failureClass) : "—"}</td>
            <td><div className="labs-attempt-evidence-actions">
              <button disabled={!attempt.attemptId || !attempt.transcriptArtifact} type="button" onClick={() => attempt.attemptId && setEvidence({ attemptId: attempt.attemptId, kind: "transcript" })}>Transcript</button>
              <button disabled={!attempt.attemptId || !attempt.traceArtifact} type="button" onClick={() => attempt.attemptId && setEvidence({ attemptId: attempt.attemptId, kind: "trace" })}>Trace</button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>{evidence ? <LabAttemptEvidenceDialog attemptId={evidence.attemptId} kind={evidence.kind} onClose={() => setEvidence(null)} onLoad={onLoadEvidence} runId={run.id} /> : null}</> : <p className="labs-detail-copy">{completed} tasks have completed. Per-task evidence is published atomically with the terminal receipt so a partial run cannot be mistaken for a final result.</p>}
    </section>
  );
}

type ModelComparisonEvaluation = Extract<
  NonNullable<ModelRun["evaluation"]>,
  { benchmarkId: "model-comparison" }
>;

function evaluationTargetLabel(evaluation: ModelComparisonEvaluation): string {
  if (evaluation.target.model) {
    return `${evaluation.target.model.providerId} / ${evaluation.target.model.modelId}`;
  }
  if (evaluation.target.kind === "base_model") {
    const parent = evaluation.comparisonPair?.parent;
    return parent?.kind === "base_model"
      ? `${parent.id} @ ${parent.revision}`
      : evaluation.target.label;
  }
  return evaluation.target.modelVersionId ?? evaluation.target.label;
}

function formatPassRate(receipt: ModelComparisonBenchmarkReceipt): string {
  const rate = receipt.deterministic.passRate;
  const interval = receipt.deterministic.passRateCi95;
  if (rate === null) return "Unavailable";
  return interval
    ? `${(rate * 100).toFixed(1)}% (${(interval.lower * 100).toFixed(1)}–${(interval.upper * 100).toFixed(1)}%)`
    : `${(rate * 100).toFixed(1)}%`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
