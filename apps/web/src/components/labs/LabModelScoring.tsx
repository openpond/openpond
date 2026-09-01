import { useEffect, useState } from "react";
import type { ChatModelRef, GraderSpec, Taskset } from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  RefreshCw,
  Shield,
} from "../icons";
import { LabStatusBadge } from "./LabStatusBadge";

type TrainingController = ReturnType<typeof useTraining>;
type MetricOperations = Awaited<
  ReturnType<TrainingController["actions"]["tasksetOperationalState"]>
>;
type PreferenceDatasets = Awaited<
  ReturnType<TrainingController["actions"]["listPreferenceDatasets"]>
>;

export function LabModelScoring({
  defaultModel,
  onToast,
  taskset,
  training,
}: {
  defaultModel: ChatModelRef;
  onToast: ShowAppToast;
  taskset: Taskset;
  training: TrainingController;
}) {
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [metricOperations, setMetricOperations] =
    useState<MetricOperations>(null);
  const [metricDatasets, setMetricDatasets] =
    useState<PreferenceDatasets>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setMetricsLoading(true);
    void Promise.all([
      training.actions.tasksetOperationalState(taskset.id),
      training.actions.listPreferenceDatasets(taskset.id),
    ])
      .then(([operations, datasets]) => {
        if (!active) return;
        setMetricOperations(operations);
        setMetricDatasets(datasets);
      })
      .catch(() => {
        if (!active) return;
        setMetricOperations(null);
        setMetricDatasets(null);
      })
      .finally(() => {
        if (active) setMetricsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [taskset.id, training.actions]);

  const metricPolicy = taskset.metrics ?? {
    primaryMetric: "score",
    aggregation: "mean_score" as const,
  };
  const grades = metricOperations?.grades ?? [];
  const scoredGrades = grades.filter((grade) => grade.score !== null);
  const meanScore = scoredGrades.length
    ? scoredGrades.reduce((sum, grade) => sum + (grade.score ?? 0), 0) /
      scoredGrades.length
    : null;
  const passRate = grades.length
    ? grades.filter((grade) => grade.passed).length / grades.length
    : null;
  const attempts = metricOperations?.attempts ?? [];
  const distinctOutputs = new Set(
    attempts.map((attempt) => JSON.stringify(attempt.output)),
  ).size;
  const preferenceGroups = (metricDatasets ?? []).reduce(
    (sum, dataset) => sum + dataset.groups.length,
    0,
  );
  const rewardGraders = taskset.graders.filter(
    (grader) => grader.rewardEligible,
  );
  const primaryGrader =
    rewardGraders.find((grader) => grader.kind === "model_judge") ??
    rewardGraders[0] ??
    null;
  const workTask =
    taskset.environment.kind === "work"
      ? taskset.tasks.find((task) => task.split !== "frozen_eval") ?? null
      : null;
  const hasModelJudge = taskset.graders.some(
    (grader) => grader.kind === "model_judge",
  );
  const isBusy = training.busyAction !== null;

  async function runCheck(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    setCheckMessage(null);
    try {
      const result = await action();
      if (!result) {
        const message = `${label} did not complete. Check the latest error and try again.`;
        setCheckMessage(message);
        onToast(message, "error");
        return;
      }
      const message = `${label} started or completed successfully.`;
      setCheckMessage(message);
      onToast(message, "success");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `${label} failed: ${detail}`;
      setCheckMessage(message);
      onToast(message, "error");
    }
  }

  return (
    <div className="labs-scoring-dashboard">
      {taskset.purpose === "benchmark" ? (
        <aside className="labs-scoring-benchmark-note">
          <Activity aria-hidden="true" size={16} />
          <div>
            <strong>Benchmark runs start from a Model</strong>
            <p>
              Open a Model and choose <b>Run Refiner Benchmark</b> to keep the
              protocol, result charts, and Git-backed receipt together.
            </p>
          </div>
        </aside>
      ) : null}

      <section
        aria-labelledby="recorded-scoring-evidence"
        className="labs-scoring-evidence"
      >
        <header className="labs-scoring-section-heading">
          <div>
            <span className="labs-scoring-section-icon">
              <Activity aria-hidden="true" size={16} />
            </span>
            <div>
              <h2 id="recorded-scoring-evidence">Recorded scoring evidence</h2>
              <p>
                Results captured from attempts against this Taskset release.
              </p>
            </div>
          </div>
          <span className="labs-scoring-updated-state" aria-live="polite">
            {metricsLoading ? "Loading evidence…" : `${attempts.length} attempts recorded`}
          </span>
        </header>

        <dl className="labs-scoring-kpis">
          <Metric
            label="Pass rate"
            value={metricsLoading ? "…" : passRate === null ? "—" : `${Math.round(passRate * 100)}%`}
            hint={grades.length ? `${grades.filter((grade) => grade.passed).length} of ${grades.length} grades passed` : "No grades recorded"}
            progress={passRate}
          />
          <Metric
            label="Mean score"
            value={metricsLoading ? "…" : meanScore === null ? "—" : meanScore.toFixed(3)}
            hint={`${scoredGrades.length} scored grade${scoredGrades.length === 1 ? "" : "s"}`}
          />
          <Metric
            label="Attempts"
            value={metricsLoading ? "…" : String(attempts.length)}
            hint={`${distinctOutputs} distinct output${distinctOutputs === 1 ? "" : "s"}`}
          />
          <Metric
            label="Artifacts"
            value={metricsLoading ? "…" : String(metricOperations?.artifacts.length ?? 0)}
            hint={`${preferenceGroups} preference group${preferenceGroups === 1 ? "" : "s"}`}
          />
        </dl>

        <dl className="labs-scoring-evidence-meta">
          <Fact label="Primary metric" value={titleCase(metricPolicy.primaryMetric)} />
          <Fact label="Aggregation" value={titleCase(metricPolicy.aggregation)} />
          <Fact label="Distinct outputs" value={metricsLoading ? "…" : String(distinctOutputs)} />
          <Fact label="Preference groups" value={metricsLoading ? "…" : String(preferenceGroups)} />
        </dl>
      </section>

      <div className="labs-scoring-layout">
        <section
          aria-labelledby="scoring-contract"
          className="labs-scoring-panel labs-scoring-contract"
        >
          <header className="labs-scoring-section-heading">
            <div>
              <span className="labs-scoring-section-icon">
                <Shield aria-hidden="true" size={16} />
              </span>
              <div>
                <h2 id="scoring-contract">Scoring contract</h2>
                <p>How outputs become reward and what the policy can see.</p>
              </div>
            </div>
            <LabStatusBadge
              label={primaryGrader ? "Configured" : "Missing reward"}
              value={primaryGrader ? "ready" : "not_run"}
            />
          </header>

          {primaryGrader ? (
            <dl className="labs-scoring-contract-facts">
              <Fact
                label="Reward source"
                value={primaryGrader.kind === "model_judge" ? "LLM-as-judge" : titleCase(primaryGrader.kind)}
              />
              <Fact label="Primary grader" value={primaryGrader.label} />
              <Fact label="Reward calculation" value={rewardCalculation(taskset)} />
              <Fact
                label="Policy boundary"
                value={taskset.policy.privilegedFields.length ? "Grading criteria hidden from Policy" : "No privileged grading fields"}
              />
              {primaryGrader.kind === "model_judge" ? (
                <>
                  <Fact
                    label="Judge model"
                    value={`${titleCase(primaryGrader.judge.providerId)} · ${primaryGrader.judge.modelId}`}
                  />
                  <Fact
                    label="Calibration"
                    value={`${titleCase(primaryGrader.calibrationStatus)}${primaryGrader.metadata.calibrationIsAdvisory === true ? " · advisory" : ""}`}
                  />
                </>
              ) : null}
            </dl>
          ) : (
            <EmptyState>No reward-eligible grader is attached to this release.</EmptyState>
          )}
        </section>

        <section
          aria-labelledby="scoring-diagnostics"
          className="labs-scoring-panel labs-scoring-diagnostics"
        >
          <header className="labs-scoring-section-heading">
            <div>
              <span className="labs-scoring-section-icon">
                <RefreshCw aria-hidden="true" size={16} />
              </span>
              <div>
                <h2 id="scoring-diagnostics">Diagnostics</h2>
                <p>Validate graders after code, fixture, or policy changes.</p>
              </div>
            </div>
          </header>

          <ReadinessSummary taskset={taskset} />

          <div className="labs-scoring-diagnostic-actions">
            {workTask ? (
              <button
                className="training-button secondary"
                disabled={isBusy}
                type="button"
                onClick={() => void runCheck(
                  "Work attempt",
                  () => training.actions.executeTasksetAttempt(
                    taskset.id,
                    workTask.id,
                    defaultModel,
                  ),
                )}
              >
                Run Work attempt
              </button>
            ) : null}
            <button
              className="training-button secondary"
              disabled={isBusy}
              type="button"
              onClick={() => void runCheck(
                "Grader audit",
                () => training.actions.auditGraders(taskset.id),
              )}
            >
              Audit graders
            </button>
            {hasModelJudge ? (
              <button
                className="training-button secondary"
                disabled={isBusy}
                type="button"
                onClick={() => void runCheck(
                  "Judge calibration",
                  () => training.actions.calibrateJudges(taskset.id),
                )}
              >
                Calibrate judges
              </button>
            ) : null}
            <button
              className="training-button secondary"
              disabled={isBusy}
              type="button"
              onClick={() => void runCheck(
                "Readiness check",
                () => training.actions.readiness(taskset.id),
              )}
            >
              <RefreshCw aria-hidden="true" className={isBusy ? "spin" : undefined} size={13} />
              Refresh readiness
            </button>
          </div>
          {checkMessage ? (
            <p className="labs-scoring-check-message" role="status">
              {checkMessage}
            </p>
          ) : null}
        </section>
      </div>

      <section
        aria-labelledby="graders-and-reward-gates"
        className="labs-scoring-panel labs-scoring-graders"
      >
        <header className="labs-scoring-section-heading">
          <div>
            <span className="labs-scoring-section-icon">
              <CheckCircle2 aria-hidden="true" size={16} />
            </span>
            <div>
              <h2 id="graders-and-reward-gates">Graders and reward gates</h2>
              <p>
                {taskset.graders.length} versioned grader{taskset.graders.length === 1 ? "" : "s"} attached to this release.
              </p>
            </div>
          </div>
        </header>

        {taskset.graders.length ? (
          <div className="labs-scoring-grader-list">
            {taskset.graders.map((grader) => (
              <GraderRow grader={grader} key={`${grader.id}:${grader.version}`} />
            ))}
          </div>
        ) : (
          <EmptyState>No graders are attached to this Taskset revision.</EmptyState>
        )}
      </section>
    </div>
  );
}

function Metric({
  hint,
  label,
  progress,
  value,
}: {
  hint: string;
  label: string;
  progress?: number | null;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <small>{hint}</small>
      {progress !== undefined && progress !== null ? (
        <span className="labs-scoring-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(progress, 1)) * 100}%` }} />
        </span>
      ) : null}
    </div>
  );
}

function GraderRow({ grader }: { grader: GraderSpec }) {
  return (
    <details className="labs-scoring-grader">
      <summary>
        <span className="labs-scoring-grader-mark" aria-hidden="true">
          <CheckCircle2 size={16} />
        </span>
        <span className="labs-scoring-grader-title">
          <strong>{grader.label}</strong>
          <small>{titleCase(grader.kind)} · v{grader.version}</small>
        </span>
        <span className="labs-scoring-grader-badges">
          {grader.rewardEligible ? <span>Reward source</span> : null}
          <LabStatusBadge
            label={grader.hardGate ? "Required" : "Advisory"}
            value={grader.hardGate ? "ready" : "available"}
          />
          <span>Weight {grader.weight}</span>
        </span>
        <ChevronDown className="labs-scoring-grader-chevron" size={15} />
      </summary>
      <div className="labs-scoring-grader-body">
        <dl>
          <Fact label="ID" value={grader.id} />
          <Fact label="Version" value={grader.version} />
          <Fact label="Reward eligible" value={grader.rewardEligible ? "Yes" : "No"} />
          <Fact label="Privileged" value={grader.privileged ? "Yes" : "No"} />
          {grader.kind === "model_judge" ? (
            <>
              <Fact label="Judge model" value={`${titleCase(grader.judge.providerId)} · ${grader.judge.modelId}`} />
              <Fact label="Calibration" value={titleCase(grader.calibrationStatus)} />
            </>
          ) : null}
        </dl>
        {!grader.privileged && "rubric" in grader ? <pre>{grader.rubric}</pre> : null}
        {!grader.privileged && "config" in grader ? <pre>{JSON.stringify(grader.config, null, 2)}</pre> : null}
        {!grader.privileged && "module" in grader ? (
          <p><code>{grader.module}</code> · {grader.exportName}</p>
        ) : null}
      </div>
    </details>
  );
}

function ReadinessSummary({ taskset }: { taskset: Taskset }) {
  if (!taskset.readiness) {
    return (
      <div className="labs-scoring-readiness neutral">
        <CircleAlert aria-hidden="true" size={16} />
        <div>
          <strong>Readiness has not been checked</strong>
          <span>Run the checks to establish a baseline for this release.</span>
        </div>
      </div>
    );
  }
  if (taskset.readiness.blockers.length) {
    return (
      <div className="labs-scoring-readiness warning">
        <CircleAlert aria-hidden="true" size={16} />
        <div>
          <strong>{taskset.readiness.blockers.length} readiness blocker{taskset.readiness.blockers.length === 1 ? "" : "s"}</strong>
          <ul>
            {taskset.readiness.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.path ?? ""}`}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (taskset.readiness.advisories.length) {
    return (
      <div className="labs-scoring-readiness warning">
        <CircleAlert aria-hidden="true" size={16} />
        <div>
          <strong>{taskset.readiness.advisories.length} advisory finding{taskset.readiness.advisories.length === 1 ? "" : "s"}</strong>
          <ul>
            {taskset.readiness.advisories.map((advisory) => (
              <li key={`${advisory.code}:${advisory.path ?? ""}`}>{advisory.message}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  return (
    <div className="labs-scoring-readiness ready">
      <CheckCircle2 aria-hidden="true" size={16} />
      <div>
        <strong>No readiness blockers</strong>
        <span>This release passed its latest readiness check.</span>
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return <p className="labs-scoring-empty">{children}</p>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function rewardCalculation(taskset: Taskset): string {
  if (taskset.metrics?.primaryMetric === "criterion_pass_rate") {
    return "Passed criteria ÷ total criteria";
  }
  if (taskset.metrics) {
    return `${titleCase(taskset.metrics.primaryMetric)} · ${titleCase(taskset.metrics.aggregation)}`;
  }
  return "Declared grader reward";
}

function titleCase(value: string): string {
  return value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
