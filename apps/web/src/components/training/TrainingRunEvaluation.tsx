import type { TrainingEvaluationGrade, TrainingRunDetail } from "@openpond/contracts";

export function TrainingRunEvaluation({ detail, loading }: { detail: TrainingRunDetail | null; loading: boolean }) {
  if (loading && !detail) return <div className="training-run-placeholder">Loading evaluation results…</div>;
  const evaluation = detail?.evaluation;
  if (!evaluation) return <div className="training-run-placeholder">No scored evaluation results are available for this run.</div>;
  return (
    <div className="training-run-evaluation">
      <div className="training-metric-summary">
        <EvaluationFact label="Base score" value={score(evaluation.base.meanScore)} />
        <EvaluationFact label="Trained score" value={score(evaluation.trained.meanScore)} />
        <EvaluationFact label="Score change" value={delta(evaluation.meanScoreDelta)} />
        <EvaluationFact label="Trained pass rate" value={rate(evaluation.trained.passRate)} />
      </div>
      {evaluation.base.count === 0 ? <p className="training-muted">Base-model scoring was not imported for this earlier run. New runs retain both base and trained evaluations.</p> : null}
      {evaluation.trained.count > 0 && evaluation.trained.scoredCount === 0 ? <p className="training-muted">Outputs were captured, but the grader was unavailable, so this run has no evaluation score.</p> : null}
      <div className="training-table-wrap">
        <table className="training-data-table training-evaluation-table">
          <thead><tr><th>Test example</th><th>Base</th><th>Trained</th><th>Result</th></tr></thead>
          <tbody>{evaluation.examples.map((example) => (
            <tr key={example.taskId}>
              <td><details><summary>{example.taskId}</summary><OutputComparison input={example.input} baseOutput={example.baseOutput} trainedOutput={example.trainedOutput} baseGrade={example.baseGrade} trainedGrade={example.trainedGrade}/></details></td>
              <td>{gradeLabel(example.baseGrade)}</td>
              <td>{gradeLabel(example.trainedGrade)}</td>
              <td>{comparisonLabel(example.baseGrade, example.trainedGrade)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function OutputComparison({ input, baseOutput, trainedOutput, baseGrade, trainedGrade }: { input: Record<string, unknown>; baseOutput: Record<string, unknown> | null; trainedOutput: Record<string, unknown> | null; baseGrade: TrainingEvaluationGrade | null; trainedGrade: TrainingEvaluationGrade | null }) {
  const feedback = [...new Set([...(baseGrade?.feedback ?? []), ...(trainedGrade?.feedback ?? [])])];
  return <div className="training-evaluation-output"><div><span>Input</span><pre>{JSON.stringify(input, null, 2)}</pre></div>{baseOutput ? <div><span>Base output</span><pre>{JSON.stringify(baseOutput, null, 2)}</pre></div> : null}{trainedOutput ? <div><span>Trained output</span><pre>{JSON.stringify(trainedOutput, null, 2)}</pre></div> : null}{feedback.length ? <div><span>Grader feedback</span><p>{feedback.join(" ")}</p></div> : null}</div>;
}

function EvaluationFact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function score(value: number | null) { return value == null ? "Not recorded" : value.toFixed(3); }
function rate(value: number | null) { return value == null ? "Not recorded" : `${Math.round(value * 100)}%`; }
function delta(value: number | null) { return value == null ? "Not comparable" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`; }
function gradeLabel(grade: TrainingEvaluationGrade | null) { return grade?.status === "unavailable" ? "Unavailable" : grade?.score == null ? "Not scored" : grade.score.toFixed(3); }
function comparisonLabel(base: TrainingEvaluationGrade | null, trained: TrainingEvaluationGrade | null) {
  if (!trained) return "Not evaluated";
  if (trained.status === "unavailable") return "Unavailable";
  if (!base || base.score == null || trained.score == null) return trained.passed ? "Passed" : "Failed";
  const change = trained.score - base.score;
  if (Math.abs(change) < 0.0005) return "No change";
  return change > 0 ? `Improved ${change.toFixed(3)}` : `Regressed ${Math.abs(change).toFixed(3)}`;
}
