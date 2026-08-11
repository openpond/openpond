import type {
  ModelEvaluationReceipt,
  ModelEvaluationStopReceipt,
  ModelRun,
} from "@openpond/contracts";

import { statusLabel } from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";
import {
  benchmarkSelectedAttempts,
  benchmarkTaskEfficiency,
} from "./benchmark-attempt-usage";

export function StoppedEvaluationDetail({
  receipt,
  onOpenConversation,
}: {
  receipt: ModelEvaluationStopReceipt;
  onOpenConversation: (conversationId: string) => void;
}) {
  return (
    <>
      <section className="labs-run-summary-card">
        <header><h3>Inconclusive benchmark</h3></header>
        <p className="training-run-placeholder">{receipt.reason}</p>
        <dl className="labs-run-detail-list">
          <Fact label="Held-out baseline tokens" value={receipt.usage.baseline.totalTokens.toLocaleString()} />
          <Fact label="Adaptation baseline tokens" value={receipt.usage.adaptation.totalTokens.toLocaleString()} />
          <Fact label="Refiner tokens" value={receipt.usage.refiner.totalTokens.toLocaleString()} />
          <Fact label="Grader tokens" value={receipt.usage.grader.totalTokens.toLocaleString()} />
          <Fact
            label="Observed / maximum spend"
            value={`$${receipt.budget.observedSpendUsd.toFixed(4)} / $${receipt.budget.maximumSpendUsd.toFixed(2)}`}
          />
          <Fact
            label="Harness candidate"
            value={receipt.stopReason === "candidate_harness_unchanged"
              ? "Unchanged"
              : "Lineage invalid"}
          />
          <Fact label="Completed attempts" value={receipt.attempts.length.toLocaleString()} />
          <Fact label="Candidate attempts" value="Skipped" />
        </dl>
      </section>
      {receipt.attempts.length ? (
        <BenchmarkAttemptTable receipt={receipt} onOpenConversation={onOpenConversation} />
      ) : null}
    </>
  );
}

export function BenchmarkProgress({ run }: { run: ModelRun }) {
  const stages = [
    "baseline",
    "adaptation",
    "refiner",
    "candidate_adaptation",
    "candidate",
    "comparison",
  ] as const;
  const stageLabels: Record<(typeof stages)[number], string> = {
    baseline: "Baseline",
    adaptation: "Adaptation",
    refiner: "Refiner",
    candidate_adaptation: "Candidate adaptation",
    candidate: "Candidate",
    comparison: "Comparison",
  };
  const currentIndex = Math.max(
    0,
    stages.indexOf(run.evaluationProgress?.stage ?? "baseline"),
  );
  const completed = run.evaluationProgress?.completedAttempts ?? 0;
  const total = run.evaluationProgress?.totalAttempts ?? 1;
  return (
    <div className="labs-benchmark-progress">
      <header>
        <h3>Benchmark progress</h3>
        <strong>{completed} of {total} attempts</strong>
      </header>
      <div className="labs-benchmark-progress-track" aria-hidden="true">
        <span style={{ width: `${Math.min(100, (completed / total) * 100)}%` }} />
      </div>
      <ol>
        {stages.map((stage, index) => (
          <li
            className={index < currentIndex ? "complete" : index === currentIndex ? "active" : undefined}
            key={stage}
          >
            <span />
            {stageLabels[stage]}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BenchmarkAttemptCharts({ receipt }: { receipt: ModelEvaluationReceipt }) {
  const efficiency = benchmarkTaskEfficiency(receipt);
  const heldOut = efficiency.pairs.filter((pair) => pair.cohort === "held_out");
  const adaptation = efficiency.pairs.filter((pair) => pair.cohort === "adaptation");
  const average = (values: number[]) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
  return (
    <div className="labs-benchmark-attempt-charts">
      <AttemptLineChart
        title="Held-out tokens by task"
        baseline={heldOut.map((pair) => pair.baseline.totalTokens)}
        candidate={heldOut.map((pair) => pair.refined.totalTokens)}
        format={(value) => Math.round(value).toLocaleString()}
      />
      <AttemptLineChart
        title="Adaptation tokens by task"
        baseline={adaptation.map((pair) => pair.baseline.totalTokens)}
        candidate={adaptation.map((pair) => pair.refined.totalTokens)}
        format={(value) => Math.round(value).toLocaleString()}
      />
      <AttemptLineChart
        title="Held-out quality by task"
        baseline={heldOut.map((pair) => pair.baseline.score)}
        candidate={heldOut.map((pair) => pair.refined.score)}
        format={(value) => value.toFixed(2)}
        summarize={average}
      />
      <AttemptLineChart
        title="Adaptation quality by task"
        baseline={adaptation.map((pair) => pair.baseline.score)}
        candidate={adaptation.map((pair) => pair.refined.score)}
        format={(value) => value.toFixed(2)}
        summarize={average}
      />
    </div>
  );
}

export function BenchmarkComparisonSummary({
  receipt,
  run,
  tasksetName,
  onOpenTaskset,
}: {
  receipt: ModelEvaluationReceipt;
  run: ModelRun;
  tasksetName: string;
  onOpenTaskset?: () => void;
}) {
  const efficiency = benchmarkTaskEfficiency(receipt);
  const pairedEvidenceAvailable = efficiency.comparedTaskCount > 0;
  const targetMet = efficiency.passed;
  const percent = efficiency.tokenDeltaPercent === null
    ? "—"
    : `${efficiency.tokenDeltaPercent > 0 ? "+" : ""}${efficiency.tokenDeltaPercent.toFixed(2)}%`;
  const cohortResult = (cohort: "adaptation" | "held_out") => {
    const result = efficiency.cohorts[cohort];
    return `${result.passedTaskCount}/${result.comparedTaskCount} passed`;
  };

  return (
    <section className="labs-run-summary-card">
      <header><h3>Token efficiency</h3></header>
      {pairedEvidenceAvailable ? (
        <div className="labs-benchmark-efficiency-summary">
          <strong>
            {efficiency.passedTaskCount} of {efficiency.comparedTaskCount} tasks passed
          </strong>
          <p>
            A task passes only when its refined token count is strictly lower
            than its own baseline. {efficiency.failedTaskCount} failed this
            token-efficiency test; aggregate usage changed by {percent}.
          </p>
        </div>
      ) : (
        <p className="training-run-placeholder">
          Paired task-level token evidence is unavailable for this run.
        </p>
      )}
      <dl className="labs-run-detail-list">
        <Fact label="Execution" value={statusLabel(run.status)} />
        <Fact
          label="Token-efficiency result"
          value={targetMet ? "Passed" : "Failed"}
        />
        <Fact
          label="Efficiency passes"
          value={`${efficiency.passedTaskCount}/${efficiency.comparedTaskCount}`}
        />
        <Fact
          label="Efficiency failures"
          value={`${efficiency.failedTaskCount}/${efficiency.comparedTaskCount}`}
        />
        <Fact
          label="All-task foreground tokens"
          value={`${efficiency.baselineTokens.toLocaleString()} → ${efficiency.refinedTokens.toLocaleString()}`}
        />
        <Fact
          label="Aggregate token change"
          value={percent}
        />
        <Fact
          label="Adaptation replay"
          value={cohortResult("adaptation")}
        />
        <Fact
          label="Held-out replay"
          value={cohortResult("held_out")}
        />
        <Fact
          label="Task quality"
          value={`${efficiency.baselinePassedCount}/${efficiency.comparedTaskCount} → ${efficiency.refinedPassedCount}/${efficiency.comparedTaskCount}`}
        />
        <Fact
          label="Result lineage"
          value={receipt.lineage.valid ? "Valid" : "Invalid"}
        />
        <div>
          <dt>Taskset</dt>
          <dd>
            {onOpenTaskset ? (
              <button
                className="labs-run-taskset-link"
                type="button"
                onClick={onOpenTaskset}
              >
                {tasksetName}
              </button>
            ) : tasksetName}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function AttemptLineChart({
  title,
  baseline,
  candidate,
  format,
  summarize = (values) => values.reduce((sum, value) => sum + value, 0),
}: {
  title: string;
  baseline: Array<number | null>;
  candidate: Array<number | null>;
  format: (value: number) => string;
  summarize?: (values: number[]) => number;
}) {
  const baselineValues = baseline.filter((value): value is number => value !== null);
  const candidateValues = candidate.filter((value): value is number => value !== null);
  const maximum = Math.max(1, ...baselineValues, ...candidateValues);
  const count = Math.max(2, baseline.length, candidate.length);
  const lineSegments = (series: Array<number | null>) => {
    const segments: string[] = [];
    let current: string[] = [];
    series.forEach((value, index) => {
      if (value === null) {
        if (current.length) segments.push(current.join(" "));
        current = [];
        return;
      }
      const x = 6 + (index / (count - 1)) * 88;
      const y = 44 - (value / maximum) * 36;
      current.push(`${x},${y}`);
    });
    if (current.length) segments.push(current.join(" "));
    return segments;
  };
  const pointCoordinates = (series: Array<number | null>) => series.flatMap(
    (value, index) => value === null
      ? []
      : [{
          x: 6 + (index / (count - 1)) * 88,
          y: 44 - (value / maximum) * 36,
        }],
  );
  return (
    <section className="labs-benchmark-line-chart">
      <header>
        <h4>{title}</h4>
        <div>
          <span>Baseline {format(summarize(baselineValues))}</span>
          <span>Refined {format(summarize(candidateValues))}</span>
        </div>
      </header>
      <svg aria-label={title} role="img" viewBox="0 0 100 50" preserveAspectRatio="none">
        <line x1="6" x2="94" y1="44" y2="44" />
        {lineSegments(baseline).map((points, index) => (
          <polyline className="baseline" key={`baseline-${index}`} points={points} />
        ))}
        {lineSegments(candidate).map((points, index) => (
          <polyline className="candidate" key={`candidate-${index}`} points={points} />
        ))}
        {pointCoordinates(baseline).map((point, index) => (
          <circle className="baseline" cx={point.x} cy={point.y} key={`baseline-point-${index}`} r="1" />
        ))}
        {pointCoordinates(candidate).map((point, index) => (
          <circle className="candidate" cx={point.x} cy={point.y} key={`candidate-point-${index}`} r="1" />
        ))}
      </svg>
    </section>
  );
}

export function BenchmarkAttemptTable({
  receipt,
  onOpenConversation,
}: {
  receipt: ModelEvaluationReceipt | ModelEvaluationStopReceipt;
  onOpenConversation: (conversationId: string) => void;
}) {
  const attempts = receipt.schemaVersion === "openpond.modelEvaluationReceipt.v1"
    ? benchmarkSelectedAttempts(receipt.attempts ?? [])
    : receipt.attempts ?? [];
  return (
    <section className="labs-run-summary-card">
      <header>
        <h3>
          {receipt.schemaVersion === "openpond.modelEvaluationReceipt.v1"
            ? "Selected task results"
            : "Completed attempts"}
        </h3>
      </header>
      <div className="training-table-wrap">
        <table className="training-data-table labs-benchmark-attempt-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Phase</th>
              <th>Result</th>
              <th>Score</th>
              <th>Tokens</th>
              <th>Work chat</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((attempt) => (
              <tr key={`${attempt.phase}:${attempt.attemptId}`}>
                <td>{humanizeTaskId(attempt.taskId)}</td>
                <td>{attempt.phase}</td>
                <td>
                  <LabStatusBadge
                    label={attempt.passed ? "Passed" : "Failed"}
                    value={attempt.passed ? "succeeded" : "failed"}
                  />
                </td>
                <td>{attempt.score === null ? "—" : attempt.score.toFixed(2)}</td>
                <td>{attempt.totalTokens.toLocaleString()}</td>
                <td>
                  {attempt.sessionId ? (
                    <button
                      className="labs-run-taskset-link"
                      type="button"
                      onClick={() => onOpenConversation(attempt.sessionId!)}
                    >
                      Open chat
                    </button>
                  ) : "Not retained"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function humanizeTaskId(taskId: string): string {
  return taskId
    .replace(/^(?:adaptation|frozen)-/, "")
    .replaceAll("-", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
