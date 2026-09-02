import type {
  ModelComparisonBenchmarkReceipt,
  ModelRun,
} from "@openpond/contracts";

import { formatDateTime } from "../training/training-model-data";

type DetailTab = "overview" | "comparison" | "activity";

export function LabModelComparisonEvaluationDetails({
  activeTab,
  receipt,
  run,
}: {
  activeTab: DetailTab;
  receipt: ModelComparisonBenchmarkReceipt | null;
  run: ModelRun;
}) {
  const evaluation = run.evaluation?.benchmarkId === "model-comparison"
    ? run.evaluation
    : null;
  if (!evaluation) return null;

  const progress = run.evaluationProgress;
  const completed = progress?.completedAttempts ?? receipt?.deterministic.completedTaskCount ?? 0;
  const total = progress?.totalAttempts ?? receipt?.deterministic.attemptedTaskCount ?? evaluation.attemptPlan[0].attemptCount;
  const percentComplete = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  const model = evaluation.target.model;

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
            <Fact label="Model" value={model ? `${model.providerId} / ${model.modelId}` : "Managed Model Version"} />
            <Fact label="Cohort" value={titleCase(evaluation.attemptPlan[0].split)} />
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
      {receipt ? <div className="training-table-wrap">
        <table className="training-data-table">
          <thead><tr><th>Task</th><th>Seed</th><th>Status</th><th>Passed</th><th>Score</th><th>Judge</th><th>Failure</th></tr></thead>
          <tbody>{receipt.attempts.map((attempt) => <tr key={`${attempt.taskId}:${attempt.seed}:${attempt.repetition}`}>
            <td>{attempt.taskId}</td>
            <td>{attempt.seed}</td>
            <td>{titleCase(attempt.status)}</td>
            <td>{attempt.passed === null ? "—" : attempt.passed ? "Yes" : "No"}</td>
            <td>{attempt.deterministicScore?.toFixed(3) ?? "—"}</td>
            <td>{attempt.judgeScore === null ? "—" : attempt.judgeScore.toFixed(1)}</td>
            <td>{attempt.failureClass ? titleCase(attempt.failureClass) : "—"}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="labs-detail-copy">{completed} tasks have completed. Per-task evidence is published atomically with the terminal receipt so a partial run cannot be mistaken for a final result.</p>}
    </section>
  );
}

export function comparisonReceipt(run: ModelRun): ModelComparisonBenchmarkReceipt | null {
  return run.receipt?.schemaVersion === "openpond.modelComparisonBenchmarkReceipt.v1"
    ? run.receipt
    : null;
}

export function comparisonRunScore(run: ModelRun): number | null {
  return comparisonReceipt(run)?.deterministic.passRate ?? null;
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
