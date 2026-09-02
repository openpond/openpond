import { useEffect, useState } from "react";
import type {
  ChatModelRef,
  ContinualLearningDailyBatch,
  ModelComparisonSeries,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { ArrowLeft, Info, X } from "../icons";
import { LabEvalsUploadDialog } from "./LabEvalsUploadDialog";
import { LabStatusBadge } from "./LabStatusBadge";
import { PreferenceDatasetSummary } from "./LabModelDataset";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { PreferenceComparisonReview } from "./PreferenceComparisonReview";
import {
  comparisonOptionLabel,
  LabLearningQueue,
  LabLearningReviewHistory,
  preferredReviewSeries,
  reviewableSeries,
} from "./LabLearningQueue";

export function LabHumanReviewsPage({
  defaultModel,
  onSelectedTasksetIdChange,
  selectedTasksetId,
  state,
  training,
  onOpenSeries,
  onToast,
}: {
  defaultModel: ChatModelRef;
  onSelectedTasksetIdChange: (tasksetId: string | null) => void;
  selectedTasksetId: string | null;
  state: TrainingStateResponse | null;
  training: ReturnType<typeof useTraining>;
  onOpenSeries: (seriesId: string) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
}) {
  const [mode, setMode] = useState<"learning" | "preference" | "history">("learning");
  const tasksets = reviewTasksets(state);
  const selected = tasksets.find((taskset) => taskset.id === selectedTasksetId) ?? null;
  const activeSeries = state ? reviewableSeries(state) : [];
  const preferredSeries = state ? preferredReviewSeries(state, activeSeries) : null;
  const [seriesId, setSeriesId] = useState(preferredSeries?.id ?? "");
  const series = activeSeries.find((candidate) => candidate.id === seriesId) ?? preferredSeries;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [runConfirmationOpen, setRunConfirmationOpen] = useState(false);

  useEffect(() => {
    if (!activeSeries.some((candidate) => candidate.id === seriesId)) {
      setSeriesId(preferredSeries?.id ?? "");
    }
  }, [activeSeries, preferredSeries?.id, seriesId]);

  const seriesBatches = state && series
    ? state.continualLearningDailyBatches.filter((batch) => batch.seriesId === series.id)
    : [];
  const stagedTasks = seriesBatches.flatMap((batch) => batch.tasks
    .filter((task) => task.stagedAt && !task.queuedEntry)
    .map((task) => ({ batch, task })));
  const awaitingResponseBatches = seriesBatches.filter((batch) => batch.intakeEvaluation.status === "awaiting" || batch.intakeEvaluation.status === "failed");

  async function startTraining() {
    if (!series || !state || !stagedTasks.length) return;
    const sourceTaskset = stagedTasks[0]!.batch.sourceTaskset;
    if (stagedTasks.some(({ batch }) => JSON.stringify(batch.sourceTaskset) !== JSON.stringify(sourceTaskset))) {
      onToast("The staged tasks do not share one source Taskset release.", "error");
      return;
    }
    const existingScheduleIds = new Set(state.comparisonSeriesEntries.filter((entry) => entry.seriesId === series.id).map((entry) => entry.scheduleEntryId));
    const next = [...series.schedule].sort((left, right) => left.ordinal - right.ordinal).find((entry) => !existingScheduleIds.has(entry.id));
    if (!next) {
      onToast("This model has no unqueued learning slot.", "error");
      return;
    }
    const reviewedAt = new Date().toISOString();
    const result = await training.actions.queueComparisonRelease({
      seriesId: series.id,
      scheduleEntryId: next.id,
      expectedSeriesRevision: series.revision,
      taskSelection: {
        source: "manual",
        taskIds: stagedTasks.map(({ task }) => task.taskId),
        observedFrom: stagedTasks.map(({ batch }) => batch.availableAt).sort()[0]!,
        observedTo: reviewedAt,
        reviewedAt,
        reviewedBy: state.profileId,
        sourceTaskset,
      },
    });
    if (!result) return;
    const queuedEntry = {
      seriesId: result.entry.seriesId,
      entryId: result.entry.id,
      scheduleEntryId: result.entry.scheduleEntryId,
      ordinal: result.entry.ordinal,
      releaseHash: result.entry.releaseHash,
    };
    const touched = new Map<string, ContinualLearningDailyBatch>();
    for (const { batch } of stagedTasks) touched.set(batch.id, batch);
    for (const batch of touched.values()) {
      await training.actions.saveContinualLearningDailyBatch({
        ...batch,
        tasks: batch.tasks.map((task) => task.stagedAt && !task.queuedEntry ? { ...task, queuedEntry } : task),
        revision: batch.revision + 1,
        updatedAt: reviewedAt,
      });
    }
    const run = await training.actions.startModelRun(series.modelProjectId, {
      maximumSpendUsd: null,
      retentionDays: null,
      exportApproved: false,
      comparisonSeriesEntryId: result.entry.id,
    });
    if (run) {
      setRunConfirmationOpen(false);
      onToast(`Started a learning run with ${stagedTasks.length} task${stagedTasks.length === 1 ? "" : "s"}.`, "success");
    }
  }

  if (selected) {
    const policy = tasksetReviewPolicy(selected);
    return (
      <div className="labs-flat-body labs-resource-page labs-human-review-page labs-human-review-detail">
        <div className="labs-dataset-detail-heading">
          <button
            aria-label="Back to Evals"
            className="labs-back-button"
            type="button"
            onClick={() => onSelectedTasksetIdChange(null)}
          >
            <ArrowLeft size={15} />
          </button>
          <div>
            <h1>{selected.name}</h1>
            <p>Blinded human preference review · Taskset revision {selected.revision}</p>
          </div>
          <LabStatusBadge label="Review queue" value="ready" />
        </div>
        <div className="labs-human-review-workspace">
          <PreferenceComparisonReview
            defaultMinimumSamples={policy.minimumSamples}
            defaultModel={defaultModel}
            defaultRubric={policy.rubric}
            reviewerKey={selected.profileId}
            tasksetId={selected.id}
            training={training}
          />
        </div>
        <div className="labs-human-review-datasets">
          <PreferenceDatasetSummary tasksetId={selected.id} training={training} />
        </div>
      </div>
    );
  }

  return (
    <div className="labs-flat-body labs-resource-page labs-human-review-page">
      <ModelProjectPageHeader
        title="Evals"
        description="Review model interactions, stage corrections, and run learning updates."
        layout="toolbar"
        actions={mode === "learning" ? (
          <div className="labs-evals-header-actions">
            <select
              aria-label="Model to evaluate"
              value={series?.id ?? ""}
              onChange={(event) => setSeriesId(event.currentTarget.value)}
            >
              <option value="">Select a model</option>
              {activeSeries.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {state ? comparisonOptionLabel(state, candidate) : candidate.name}
                </option>
              ))}
            </select>
            <button aria-label="Scoring and provenance" className="training-icon-button" disabled={!series} title="Scoring and provenance" type="button" onClick={() => setSettingsOpen(true)}><Info size={15} /></button>
            <button className="training-button secondary" disabled={!series} type="button" onClick={() => setUploadOpen(true)}>Upload tasks</button>
            <button className="training-button" disabled={!stagedTasks.length || training.busyAction !== null} type="button" onClick={() => setRunConfirmationOpen(true)}>Start training</button>
          </div>
        ) : undefined}
      />
      <nav aria-label="Evals workspace" className="labs-review-mode-tabs">
        <button className={mode === "learning" ? "selected" : undefined} type="button" onClick={() => setMode("learning")}>Issues</button>
        <button className={mode === "preference" ? "selected" : undefined} type="button" onClick={() => setMode("preference")}>Preference calibration</button>
        <button className={mode === "history" ? "selected" : undefined} type="button" onClick={() => setMode("history")}>Decision history</button>
      </nav>
      {mode === "learning" && state ? <LabLearningQueue onOpenSeries={onOpenSeries} onToast={onToast} series={series ?? null} state={state} training={training} /> : null}
      {mode === "history" && state ? <LabLearningReviewHistory onOpenSeries={onOpenSeries} state={state} /> : null}
      {mode === "preference" ? <section className="training-detail-section labs-human-review-queues">
        <h2>Preference calibration</h2>
        <p className="labs-detail-copy">
          This secondary workflow calibrates taste-based or model-judge grading against blinded human choices. It is separate from the deterministic Tau daily-issue loop.
        </p>
        <div className="training-table-wrap">
          <table className="training-data-table">
            <thead><tr><th>Taskset</th><th>Review method</th><th>Scorers</th><th>Target</th><th>Revision</th></tr></thead>
            <tbody>
              {tasksets.map((taskset) => {
                const policy = tasksetReviewPolicy(taskset);
                return (
                  <tr key={`${taskset.id}:${taskset.revision}`}>
                    <td>
                      <button
                        className="labs-version-row-button"
                        type="button"
                        onClick={() => onSelectedTasksetIdChange(taskset.id)}
                      >
                        <strong>{taskset.name}</strong>
                        <small>{taskset.objective}</small>
                      </button>
                    </td>
                    <td>{reviewMethod(taskset)}</td>
                    <td>{taskset.graders.length}</td>
                    <td>{policy.minimumSamples} reviews</td>
                    <td>{taskset.revision}</td>
                  </tr>
                );
              })}
              {!tasksets.length ? (
                <tr><td colSpan={5}><div className="training-run-placeholder">No Tasksets currently expose a human-review workflow.</div></td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section> : null}

      {settingsOpen && series ? (
        <ScoringProvenanceDialog series={series} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {uploadOpen && series && state ? <LabEvalsUploadDialog awaitingBatchIds={awaitingResponseBatches.map((batch) => batch.id)} onClose={() => setUploadOpen(false)} onToast={onToast} series={series} state={state} training={training} /> : null}
      {runConfirmationOpen ? (
        <AppDialog ariaLabel="Start training" backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-run-confirmation-dialog" dismissDisabled={training.busyAction !== null} onClose={() => setRunConfirmationOpen(false)}>
            <header><div><h2>Start training</h2><p>Training will start with exactly these staged tasks.</p></div><button aria-label="Close run confirmation" disabled={training.busyAction !== null} type="button" onClick={() => setRunConfirmationOpen(false)}><X size={16} /></button></header>
            <ul>{stagedTasks.map(({ task }) => <li key={task.taskId}>{task.taskId}</li>)}</ul>
            <footer><button disabled={training.busyAction !== null} type="button" onClick={() => setRunConfirmationOpen(false)}>Cancel</button><button disabled={training.busyAction !== null} type="submit" onClick={() => void startTraining()}>Start training</button></footer>
        </AppDialog>
      ) : null}
    </div>
  );
}

function ScoringProvenanceDialog({
  onClose,
  series,
}: {
  onClose: () => void;
  series: ModelComparisonSeries;
}) {
  return (
    <AppDialog ariaLabel="Scoring and provenance" backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-scoring-provenance-dialog" onClose={onClose}>
        <header><div><h2>Scoring &amp; provenance</h2><p>Technical details for this model’s continual-learning loop.</p></div><button aria-label="Close settings" type="button" onClick={onClose}><X size={16} /></button></header>
        <dl>
          <div><dt>Series</dt><dd>{series.id}</dd></div>
          <div><dt>Task pool</dt><dd>{series.eligibleTaskPool.id}@{series.eligibleTaskPool.revision}</dd></div>
          <div><dt>Grader version</dt><dd>{series.grader.id}</dd></div>
          <div><dt>Grader hash</dt><dd>{series.grader.contentHash}</dd></div>
          <div><dt>Execution</dt><dd>Queueing never starts a paid training run.</dd></div>
        </dl>
    </AppDialog>
  );
}

function reviewTasksets(state: TrainingStateResponse | null): Taskset[] {
  const tasksets = new Map<string, Taskset>();
  for (const taskset of [...(state?.tasksets ?? []), ...(state?.modelTasksets ?? [])]) {
    if (
      taskset.preferenceComparison ||
      taskset.graders.some((grader) => grader.kind === "human" || grader.kind === "model_judge") ||
      taskset.metadata.tasksetReviewPolicy
    ) {
      tasksets.set(`${taskset.id}:${taskset.revision}:${taskset.contentHash}`, taskset);
    }
  }
  return [...tasksets.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function tasksetReviewPolicy(taskset: Taskset): {
  minimumSamples: number;
  rubric: string;
} {
  const stored = taskset.metadata.tasksetReviewPolicy;
  const policy = stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : null;
  const graderRubric = taskset.graders.find(
    (grader) => grader.kind === "model_judge" || grader.kind === "human",
  );
  return {
    minimumSamples: typeof policy?.minimumSamples === "number"
      ? policy.minimumSamples
      : 100,
    rubric: typeof policy?.rubric === "string"
      ? policy.rubric
      : graderRubric && !graderRubric.privileged && "rubric" in graderRubric
        ? graderRubric.rubric
        : "Rank the candidates by overall task quality.",
  };
}

function reviewMethod(taskset: Taskset): string {
  const human = taskset.graders.some((grader) => grader.kind === "human");
  const judge = taskset.graders.some((grader) => grader.kind === "model_judge");
  if (human && judge) return "Human + LLM judge";
  if (human) return "Human rubric";
  if (judge) return "Judge calibration";
  return "Preference comparison";
}
