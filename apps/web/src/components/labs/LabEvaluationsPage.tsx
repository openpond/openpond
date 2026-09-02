import { useMemo, useState } from "react";
import type {
  ModelEvaluationReceipt,
  ModelRun,
  TrainingStateResponse,
} from "@openpond/contracts";

import { ArrowLeft } from "../icons";
import type { useTraining } from "../../hooks/useTraining";
import {
  formatDateTime,
  statusLabel,
} from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";
import { LabModelComparisonEvaluationDetails } from "./LabModelComparisonEvaluationDetails";
import {
  comparisonReceipt,
  comparisonRunScore,
} from "./model-comparison-evaluation";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { LabEvaluationRunCreateDialog } from "./LabEvaluationRunCreateDialog";

export type EvaluationDetailTab = "overview" | "comparison" | "activity";

const EVALUATION_DETAIL_TABS: Array<{
  id: EvaluationDetailTab;
  label: string;
}> = [
  { id: "overview", label: "Overview" },
  { id: "comparison", label: "Comparison" },
  { id: "activity", label: "Attempts" },
];

export function LabEvaluationsPage({
  detailTab,
  modelProjectId,
  onDetailTabChange,
  onSelectedEvaluationIdChange,
  selectedEvaluationId,
  state,
  training,
  onToast,
}: {
  detailTab?: EvaluationDetailTab | null;
  modelProjectId?: string | null;
  onDetailTabChange: (tab: EvaluationDetailTab) => void;
  onSelectedEvaluationIdChange: (evaluationId: string | null) => void;
  selectedEvaluationId: string | null;
  state: TrainingStateResponse | null;
  training: ReturnType<typeof useTraining>;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const runs = useMemo(
    () => evaluationRuns(state, modelProjectId ?? null),
    [modelProjectId, state],
  );
  const selected = runs.find((run) => run.id === selectedEvaluationId) ?? null;
  const tasksets = tasksetsById(state);
  const projects = new Map(
    (state?.modelProjects ?? []).map((project) => [project.id, project] as const),
  );

  if (selected) {
    return (
      <EvaluationDetail
        detailTab={detailTab ?? "overview"}
        run={selected}
        state={state}
        tasksetName={tasksets.get(selected.taskset.id) ?? selected.taskset.id}
        onBack={() => onSelectedEvaluationIdChange(null)}
        onDetailTabChange={onDetailTabChange}
        training={training}
      />
    );
  }

  const completed = runs.filter((run) => run.status === "succeeded");
  const comparableSuites = new Set(
    completed.map((run) => `${run.taskset.id}:${run.taskset.contentHash}`),
  ).size;

  return (
    <div className="labs-flat-body labs-resource-page">
      <ModelProjectPageHeader
        title="Evaluations"
        description={modelProjectId
          ? "Compare Model Versions on frozen Taskset and scoring releases."
          : "Evaluation studies and comparable results across Model Projects."}
        metrics={[
          { label: "Evaluation runs", value: runs.length },
          { label: "Completed", value: completed.length },
          { label: "Comparable suites", value: comparableSuites },
        ]}
        actions={<button className="training-button" disabled={!state || Boolean(training.busyAction)} type="button" onClick={() => setCreateOpen(true)}>New evaluation run</button>}
      />
      <EvaluationComparisonSummary runs={completed} state={state} />
      <section className="training-detail-section">
        <h2>Evaluation history</h2>
        <div className="training-table-wrap">
          <table className="training-data-table">
            <thead>
              <tr>
                <th>Evaluation</th>
                {!modelProjectId ? <th>Model Project</th> : null}
                <th>Model Version</th>
                <th>Taskset</th>
                <th>Status</th>
                <th>Candidate score</th>
                <th>Delta</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const receipt = evaluationReceipt(run);
                const comparisonScore = comparisonRunScore(run);
                const version = state?.modelVersions.find(
                  (candidate) => candidate.id === run.modelVersionId,
                );
                return (
                  <tr key={run.id}>
                    <td>
                      <button
                        className="labs-version-row-button"
                        type="button"
                        onClick={() => onSelectedEvaluationIdChange(run.id)}
                      >
                        <strong>{run.evaluation?.benchmarkId ?? "Evaluation"}</strong>
                        <small>{run.id}</small>
                      </button>
                    </td>
                    {!modelProjectId ? <td>{projects.get(run.modelId)?.name ?? run.modelId}</td> : null}
                    <td>{version ? `Version ${version.version}` : evaluationTargetLabel(run)}</td>
                    <td>{tasksets.get(run.taskset.id) ?? run.taskset.id}</td>
                    <td><LabStatusBadge label={statusLabel(run.status)} value={run.status} /></td>
                    <td>{receipt ? percent(receipt.quality.candidatePassRate) : comparisonScore === null ? runningProgress(run) : percent(comparisonScore)}</td>
                    <td>{receipt ? signedPercent(receipt.quality.candidatePassRate - receipt.quality.baselinePassRate) : "—"}</td>
                    <td>{formatDateTime(run.updatedAt)}</td>
                  </tr>
                );
              })}
              {!runs.length ? (
                <tr>
                  <td colSpan={modelProjectId ? 7 : 8}>
                    <div className="training-run-placeholder">No evaluation runs yet.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      {createOpen && state ? <LabEvaluationRunCreateDialog
        busy={training.busyAction === "start-comparison-evaluation"}
        modelProjectId={modelProjectId}
        onClose={() => setCreateOpen(false)}
        onStart={async (input) => {
          const run = await training.actions.startComparisonEvaluation(input);
          onToast(run ? "Evaluation Run started. Evidence will update without changing the operator decision." : "The Evaluation Run did not start.", run ? "success" : "error");
          if (run) onSelectedEvaluationIdChange(run.id);
          return run;
        }}
        state={state}
      /> : null}
    </div>
  );
}

function EvaluationComparisonSummary({
  runs,
  state,
}: {
  runs: ModelRun[];
  state: TrainingStateResponse | null;
}) {
  const groups = new Map<string, ModelRun[]>();
  for (const run of runs) {
    const key = `${run.taskset.id}:${run.taskset.contentHash}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const comparable = [...groups.values()].filter((group) => group.length > 1);
  const tasksetNames = tasksetsById(state);
  if (!comparable.length) {
    return (
      <section className="training-detail-section">
        <h2>Version comparison</h2>
        <p className="labs-detail-copy">
          Complete two evaluations against the same immutable Taskset and scoring release to compare versions here.
        </p>
      </section>
    );
  }
  return (
    <section className="training-detail-section">
      <h2>Version comparison</h2>
      <p className="labs-detail-copy">
        Scores are grouped only when the Taskset content hash is identical.
      </p>
      <div className="labs-evaluation-matrix">
        {comparable.map((group) => {
          const latest = [...group].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          );
          return (
            <article className="labs-resource-card" key={`${group[0]!.taskset.id}:${group[0]!.taskset.contentHash}`}>
              <header>
                <strong>{tasksetNames.get(group[0]!.taskset.id) ?? group[0]!.taskset.id}</strong>
                <span>{group.length} comparable runs</span>
              </header>
              <div className="labs-evaluation-score-row">
                {latest.slice(0, 4).map((run) => {
                  const receipt = evaluationReceipt(run);
                  const comparisonScore = comparisonRunScore(run);
                  const version = state?.modelVersions.find((candidate) => candidate.id === run.modelVersionId);
                  return (
                    <div key={run.id}>
                      <span>{version ? `Version ${version.version}` : evaluationTargetLabel(run)}</span>
                      <strong>{receipt ? percent(receipt.quality.candidatePassRate) : comparisonScore === null ? "—" : percent(comparisonScore)}</strong>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EvaluationDetail({
  detailTab,
  onBack,
  onDetailTabChange,
  run,
  state,
  tasksetName,
  training,
}: {
  detailTab: EvaluationDetailTab;
  onBack: () => void;
  onDetailTabChange: (tab: EvaluationDetailTab) => void;
  run: ModelRun;
  state: TrainingStateResponse | null;
  tasksetName: string;
  training: ReturnType<typeof useTraining>;
}) {
  const receipt = evaluationReceipt(run);
  const modelComparisonReceipt = comparisonReceipt(run);
  const isModelComparison = run.evaluation?.benchmarkId === "model-comparison";
  const activeTab = EVALUATION_DETAIL_TABS.some((tab) => tab.id === detailTab)
    ? detailTab
    : "overview";
  const version = state?.modelVersions.find((candidate) => candidate.id === run.modelVersionId);
  return (
    <div className="labs-flat-body labs-resource-page">
      <div className="labs-dataset-detail-heading">
        <button aria-label="Back to Evaluations" className="labs-back-button" type="button" onClick={onBack}>
          <ArrowLeft size={15} />
        </button>
        <div>
          <h1>{isModelComparison ? `Model comparison · ${evaluationTargetLabel(run)}` : run.evaluation?.benchmarkId ?? "Evaluation"}</h1>
          <p>{tasksetName} · {version ? `Version ${version.version}` : evaluationTargetLabel(run)}</p>
        </div>
        <LabStatusBadge label={statusLabel(run.status)} value={run.status} />
      </div>
      <div className="training-detail-tabs" role="tablist" aria-label="Evaluation details">
        {EVALUATION_DETAIL_TABS.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "active" : undefined}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => onDetailTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {isModelComparison ? <LabModelComparisonEvaluationDetails activeTab={activeTab} receipt={modelComparisonReceipt} run={run} onLoadEvidence={training.actions.loadComparisonAttemptEvidence} /> : activeTab === "overview" ? (
        <section className="training-detail-section">
          <h2>Evaluation result</h2>
          <dl className="labs-inline-facts">
            <Fact label="Baseline" value={receipt ? percent(receipt.quality.baselinePassRate) : "—"} />
            <Fact label="Candidate" value={receipt ? percent(receipt.quality.candidatePassRate) : "—"} />
            <Fact label="Delta" value={receipt ? signedPercent(receipt.quality.candidatePassRate - receipt.quality.baselinePassRate) : "—"} />
            <Fact label="Retention" value={receipt ? (receipt.quality.heldOutCandidatePassed ? "Passed" : "Failed") : "—"} />
            <Fact label="New-task slice" value={receipt ? (receipt.quality.adaptationCandidatePassed ? "Passed" : "Failed") : "—"} />
            <Fact label="Spend" value={receipt ? `$${receipt.budget.observedSpendUsd.toFixed(2)}` : "—"} />
          </dl>
          {run.failure ? <p className="training-banner error">{run.failure}</p> : null}
        </section>
      ) : null}
      {!isModelComparison && activeTab === "comparison" ? (
        <section className="training-detail-section">
          <h2>Baseline versus candidate</h2>
          {receipt ? (
            <div className="labs-evaluation-score-row labs-evaluation-score-row-large">
              <div><span>Baseline pass rate</span><strong>{percent(receipt.quality.baselinePassRate)}</strong></div>
              <div><span>Candidate pass rate</span><strong>{percent(receipt.quality.candidatePassRate)}</strong></div>
              <div><span>Change</span><strong>{signedPercent(receipt.quality.candidatePassRate - receipt.quality.baselinePassRate)}</strong></div>
            </div>
          ) : <p className="labs-detail-copy">A canonical comparison receipt has not been recorded.</p>}
        </section>
      ) : null}
      {!isModelComparison && activeTab === "activity" ? (
        <section className="training-detail-section">
          <h2>Attempt evidence</h2>
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead><tr><th>Phase</th><th>Task</th><th>Passed</th><th>Score</th><th>Latency</th></tr></thead>
              <tbody>{(receipt?.attempts ?? []).map((attempt) => (
                <tr key={attempt.attemptId}>
                  <td>{titleCase(attempt.phase)}</td>
                  <td>{attempt.taskId}</td>
                  <td>{attempt.passed ? "Yes" : "No"}</td>
                  <td>{attempt.score === null ? "—" : attempt.score.toFixed(3)}</td>
                  <td>{Math.round(attempt.latencyMs / 1000)}s</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function evaluationRuns(
  state: TrainingStateResponse | null,
  modelProjectId: string | null,
): ModelRun[] {
  return (state?.modelRuns ?? [])
    .filter((run) => run.kind === "evaluation" && (!modelProjectId || run.modelId === modelProjectId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function tasksetsById(state: TrainingStateResponse | null): Map<string, string> {
  const result = new Map<string, string>();
  for (const taskset of [...(state?.tasksets ?? []), ...(state?.modelTasksets ?? [])]) {
    result.set(taskset.id, taskset.name);
  }
  return result;
}

function evaluationReceipt(run: ModelRun): ModelEvaluationReceipt | null {
  return run.receipt?.schemaVersion === "openpond.modelEvaluationReceipt.v1"
    ? run.receipt
    : null;
}

function evaluationTargetLabel(run: ModelRun): string {
  return run.evaluation?.benchmarkId === "model-comparison"
    ? run.evaluation.target.label
    : run.modelVersionId ?? "Unversioned target";
}

function runningProgress(run: ModelRun): string {
  if (!run.evaluationProgress || run.status !== "running") return "—";
  return `${run.evaluationProgress.completedAttempts}/${run.evaluationProgress.totalAttempts}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPercent(value: number): string {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
