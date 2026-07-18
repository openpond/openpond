import type { CrossSystemFrontierBaselineRun } from "@openpond/contracts";

import { DetailSection } from "../training/DetailSection";

export function LabModelBaselineProgress({
  run,
  showOutcomes = true,
}: {
  run: CrossSystemFrontierBaselineRun;
  showOutcomes?: boolean;
}) {
  const { completedTasks, currentTask, totalTasks } = run.progress;
  const detail = currentTask
    ? `${humanize(currentTask.family)} · ${currentTask.worldId}`
    : run.progress.stage === "complete"
      ? "Baseline complete"
      : humanize(run.progress.stage);

  return (
    <div
      className="labs-training-run-progress-wrap"
      aria-live={isActiveBaseline(run) ? "polite" : "off"}
    >
      <div className="labs-training-run-progress">
        <progress max={Math.max(1, totalTasks)} value={completedTasks}>
          {completedTasks} of {totalTasks} tasks
        </progress>
        <small>{completedTasks} / {totalTasks} · {detail}</small>
      </div>
      {showOutcomes ? (
        <span className="labs-training-run-verdicts">
          {run.progress.outcomes.correct} exact · {run.progress.outcomes.incorrect} incorrect ·{" "}
          {run.progress.outcomes.parseFailure} format ·{" "}
          {run.progress.outcomes.infrastructureFailure} infrastructure
        </span>
      ) : null}
    </div>
  );
}

export function LabModelBaselineData({
  run,
}: {
  run: CrossSystemFrontierBaselineRun;
}) {
  return (
    <>
      <DetailSection title="Dataset">
        <dl className="labs-inline-facts">
          <Fact label="Scenarios" value={String(run.worldSpecs.length)} />
          <Fact label="Recorded runs" value={String(run.sourceIds.length)} />
          <Fact label="Training" value={String(splitCount(run, "train"))} />
          <Fact label="Frozen Evals" value={String(splitCount(run, "frozen_eval"))} />
        </dl>
      </DetailSection>
      <DetailSection title="Dataset splits">
        <div className="training-taskset-facts">
          <span><strong>{splitCount(run, "train")}</strong> training scenarios</span>
          <span><strong>{splitCount(run, "validation")}</strong> validation scenarios</span>
          <span><strong>{splitCount(run, "frozen_eval")}</strong> frozen Eval scenarios</span>
          <span><strong>{run.sourceIds.length}</strong> recorded trajectories</span>
        </div>
      </DetailSection>
    </>
  );
}

export function LabModelBaselineEvals({
  run,
}: {
  run: CrossSystemFrontierBaselineRun;
}) {
  const { outcomes } = run.progress;
  return (
    <DetailSection title="Cross-System baseline">
      <LabModelBaselineProgress run={run} />
      <dl className="labs-inline-facts labs-model-baseline-facts">
        <Fact label="Exact" value={String(outcomes.correct)} />
        <Fact label="Incorrect" value={String(outcomes.incorrect)} />
        <Fact label="Format" value={String(outcomes.parseFailure)} />
        <Fact label="Infrastructure" value={String(outcomes.infrastructureFailure)} />
      </dl>
      {run.status === "succeeded" ? null : (
        <p className="labs-detail-copy">
          The deterministic verifier is scoring exact cross-system answers as each world completes.
        </p>
      )}
    </DetailSection>
  );
}

export function frontierBaselineStatusLabel(
  run: CrossSystemFrontierBaselineRun,
): string {
  if (run.status === "queued") return "Queued";
  if (run.status === "cancelling") return "Cancelling";
  if (run.status === "cancelled") return "Cancelled";
  if (run.status === "succeeded") return "Baseline ready";
  if (run.status === "failed") return "Baseline failed";
  if (run.progress.stage === "preparing") return "Preparing baseline";
  if (run.progress.stage === "persisting") return "Saving baseline";
  return "Running baseline";
}

export function isActiveBaseline(run: CrossSystemFrontierBaselineRun): boolean {
  return ["queued", "running", "cancelling"].includes(run.status);
}

function splitCount(
  run: CrossSystemFrontierBaselineRun,
  split: CrossSystemFrontierBaselineRun["worldSpecs"][number]["split"],
): number {
  return run.worldSpecs.filter((spec) => spec.split === split).length;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
