import type {
  ModelEvaluationReceipt,
  ModelEvaluationStopReceipt,
  ModelRun,
} from "@openpond/contracts";

import { LabStatusBadge } from "./LabStatusBadge";

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
  const attempts = receipt.attempts ?? [];
  const baseline = attempts.filter((attempt) => attempt.phase === "baseline");
  const candidate = attempts.filter((attempt) => attempt.phase === "candidate");
  const adaptation = attempts.filter((attempt) => attempt.phase === "adaptation");
  const candidateAdaptation = attempts.filter(
    (attempt) => attempt.phase === "candidate_adaptation",
  );
  const average = (values: number[]) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
  return (
    <div className="labs-benchmark-attempt-charts">
      <AttemptLineChart
        title="Held-out quality by task"
        baseline={baseline.map((attempt) => attempt.score)}
        candidate={candidate.map((attempt) => attempt.score)}
        format={(value) => value.toFixed(2)}
        summarize={average}
      />
      <AttemptLineChart
        title="Held-out tokens by task"
        baseline={baseline.map((attempt) => attempt.totalTokens)}
        candidate={candidate.map((attempt) => attempt.totalTokens)}
        format={(value) => Math.round(value).toLocaleString()}
      />
      <AttemptLineChart
        title="Adaptation replay quality by task"
        baseline={adaptation.map((attempt) => attempt.score)}
        candidate={candidateAdaptation.map((attempt) => attempt.score)}
        format={(value) => value.toFixed(2)}
        summarize={average}
      />
    </div>
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
          <span>Candidate {format(summarize(candidateValues))}</span>
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
  return (
    <section className="labs-run-summary-card">
      <header><h3>Task attempts</h3></header>
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
            {(receipt.attempts ?? []).map((attempt) => (
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
