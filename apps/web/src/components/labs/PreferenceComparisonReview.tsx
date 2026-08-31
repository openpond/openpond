import { useEffect, useMemo, useState } from "react";
import type { ChatModelRef } from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { DetailSection } from "../training/DetailSection";

type PreferenceRating = "love" | "like" | "reject";

const PREFERENCE_RATINGS: Array<{
  id: PreferenceRating;
  label: string;
  score: number;
}> = [
  { id: "love", label: "Love", score: 1 },
  { id: "like", label: "Like", score: 0.5 },
  { id: "reject", label: "Reject", score: 0 },
];

export function preferenceRatingsSubmission(
  candidateIds: string[],
  ratings: Record<string, PreferenceRating>,
): {
  order: string[][];
  rejectAll: boolean;
  criterionScores: Record<string, Record<string, number>>;
} {
  const order = PREFERENCE_RATINGS
    .map((rating) => candidateIds.filter((candidateId) => ratings[candidateId] === rating.id))
    .filter((group) => group.length > 0);
  const rejectAll = candidateIds.length > 0
    && candidateIds.every((candidateId) => ratings[candidateId] === "reject");
  return {
    order: rejectAll ? [] : order,
    rejectAll,
    criterionScores: Object.fromEntries(candidateIds.map((candidateId) => [
      candidateId,
      {
        overall_quality: PREFERENCE_RATINGS.find((rating) => rating.id === ratings[candidateId])?.score ?? 0,
      },
    ])),
  };
}

export function PreferenceComparisonReview({
  tasksetId,
  reviewerKey,
  defaultModel,
  defaultRubric,
  defaultMinimumSamples,
  training,
}: {
  tasksetId: string;
  reviewerKey: string;
  defaultModel: ChatModelRef;
  defaultRubric: string;
  defaultMinimumSamples: number;
  training: ReturnType<typeof useTraining>;
}) {
  const [review, setReview] = useState<Awaited<ReturnType<typeof training.actions.nextPreferenceComparison>>>(null);
  const [queueChecked, setQueueChecked] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Record<string, PreferenceRating>>({});
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [rubric, setRubric] = useState(defaultRubric);
  const [minimumSamples, setMinimumSamples] = useState(defaultMinimumSamples);
  const [calibrationJobId, setCalibrationJobId] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<Awaited<ReturnType<typeof training.actions.preferenceCalibrationStatus>>>(null);
  const [datasets, setDatasets] = useState<Awaited<ReturnType<typeof training.actions.listPreferenceDatasets>>>(null);
  const [calibrationMessage, setCalibrationMessage] = useState<string | null>(null);
  const candidateIds = useMemo(() => review?.candidates.map((candidate) => candidate.attemptId) ?? [], [review]);
  const completedRatings = useMemo(
    () => candidateIds.filter((candidateId) => ratings[candidateId]).length,
    [candidateIds, ratings],
  );

  useEffect(() => () => {
    for (const url of Object.values(previewUrls)) URL.revokeObjectURL(url);
  }, [previewUrls]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      training.actions.preferenceCalibrationStatus(tasksetId, reviewerKey),
      training.actions.listPreferenceDatasets(tasksetId),
    ]).then(([nextCalibration, nextDatasets]) => {
      if (!active) return;
      setCalibration(nextCalibration);
      setDatasets(nextDatasets);
    });
    return () => { active = false; };
  }, [reviewerKey, tasksetId, training.actions]);

  async function loadNext(): Promise<void> {
    for (const url of Object.values(previewUrls)) URL.revokeObjectURL(url);
    setPreviewUrls({});
    setRatings({});
    setReason("");
    const next = await training.actions.nextPreferenceComparison(tasksetId, reviewerKey);
    setQueueChecked(true);
    setReview(next);
    setStartedAt(next ? new Date().toISOString() : null);
    if (!next) return;
    const imageArtifacts = next.candidates.flatMap((candidate) => candidate.artifacts
      .filter((artifact) => artifact.mediaType?.startsWith("image/"))
      .map((artifact) => artifact.id));
    const settled = await Promise.all(imageArtifacts.map(async (artifactId) => [
      artifactId,
      await training.actions.preferenceArtifactUrl(artifactId),
    ] as const));
    setPreviewUrls(Object.fromEntries(settled.filter((entry): entry is [string, string] => entry[1] !== null)));
  }

  async function submit(): Promise<void> {
    if (!review || !startedAt) return;
    const submission = preferenceRatingsSubmission(candidateIds, ratings);
    const result = await training.actions.submitPreferenceComparison({
      tasksetId,
      assignmentId: review.assignment.id,
      reviewerKey,
      ...submission,
      startedAt,
    });
    if (result) await loadNext();
  }

  async function markUnreviewable(): Promise<void> {
    if (!review || !reason.trim()) return;
    const result = await training.actions.markPreferenceComparisonUnreviewable({
      tasksetId,
      assignmentId: review.assignment.id,
      reviewerKey,
      reason: reason.trim(),
    });
    if (result) await loadNext();
  }

  async function refreshCalibration(): Promise<void> {
    const status = await training.actions.preferenceCalibrationStatus(tasksetId, reviewerKey);
    setCalibration(status);
  }

  async function refreshDatasets(): Promise<void> {
    setDatasets(await training.actions.listPreferenceDatasets(tasksetId));
  }

  async function runNextModelReview(): Promise<void> {
    if (!rubric.trim()) return;
    setCalibrationMessage(null);
    const result = await training.actions.runNextPreferenceCalibrationReview({
      tasksetId,
      reviewerKey,
      comparisonReleaseId: calibration?.release?.id ?? null,
      model: defaultModel,
      rubric: rubric.trim(),
    });
    if (!result) {
      setCalibrationMessage("Model review did not complete. The error above identifies whether artifacts, transport, model output, or portable validation owns the failure.");
      return;
    }
    setCalibrationMessage("One pending canonical or swapped-order model review completed.");
    await refreshCalibration();
  }

  async function startCalibrationBatch(): Promise<void> {
    if (!rubric.trim()) return;
    setCalibrationMessage(null);
    const result = await training.actions.startPreferenceCalibrationBatch({
      tasksetId,
      reviewerKey,
      rubric: rubric.trim(),
      minimumSamples,
    });
    if (!result) return;
    setCalibrationJobId(result.job.id);
    setCalibrationMessage(`Managed candidate batch ${result.job.id} is ${result.job.state}. Sync it after the hosted rollout completes.`);
    await refreshCalibration();
  }

  async function syncCalibrationBatch(): Promise<void> {
    if (!calibrationJobId) return;
    const result = await training.actions.syncPreferenceCalibrationBatch({
      tasksetId,
      reviewerKey,
      jobId: calibrationJobId,
    });
    if (!result) return;
    if (result.assignment) {
      setCalibrationMessage("Managed candidates were verified, imported, and queued as a blinded human assignment.");
      setCalibrationJobId(null);
      await loadNext();
      await refreshCalibration();
      return;
    }
    setCalibrationMessage(
      result.job.terminalReason
        ? `Managed batch ${result.job.state}: ${result.job.terminalReason}`
        : `Managed batch is ${result.job.state}.`,
    );
  }

  async function finalizeCalibration(): Promise<void> {
    if (!calibration?.release) return;
    const report = await training.actions.savePreferenceCalibration({
      tasksetId,
      reviewerKey,
      comparisonReleaseId: calibration.release.id,
      model: defaultModel,
    }) as { passed?: boolean } | null;
    if (!report) return;
    setCalibrationMessage(report.passed ? "Calibration passed and is ready for managed reward admission." : "Calibration was saved but did not pass the frozen thresholds.");
    await refreshCalibration();
  }

  return (
    <DetailSection title="Review workspace">
      <h3>My review queue</h3>
      <p className="labs-detail-copy">
        Open one blinded assignment, rate every candidate Love, Like, or Reject, and submit one immutable review. Each submission is retained separately by reviewer and assignment.
      </p>
      {calibration ? (
        <p className="labs-detail-copy">
          {calibration.humanCompleted} human review{calibration.humanCompleted === 1 ? "" : "s"} saved · target {calibration.minimumSamples ?? defaultMinimumSamples}
        </p>
      ) : null}
      {review === null ? (
        <>
          <button className="training-button" type="button" onClick={() => void loadNext()}>
            {queueChecked ? "Check for another review" : "Open next review"}
          </button>
          {queueChecked ? <p className="labs-detail-copy">No queued review is currently available.</p> : null}
        </>
      ) : (
        <>
          {review.taskPrompt ? <pre className="labs-detail-copy">{JSON.stringify(review.taskPrompt, null, 2)}</pre> : null}
          <div className="preference-review-grid">
            {review.candidates.map((candidate) => {
              const rating = ratings[candidate.attemptId];
              return (
                <article className="preference-review-card" key={candidate.attemptId}>
                  <header>
                    <strong>{candidate.label}</strong>
                    <small>{rating ? PREFERENCE_RATINGS.find((option) => option.id === rating)?.label : "Not rated"}</small>
                  </header>
                  {candidate.artifacts.map((artifact) => previewUrls[artifact.id] ? (
                    <img
                      alt={`${candidate.label} artifact`}
                      className="preference-review-artifact"
                      key={artifact.id}
                      src={previewUrls[artifact.id]}
                    />
                  ) : null)}
                  <pre className="labs-detail-copy">{JSON.stringify(candidate.output, null, 2)}</pre>
                  <div className="preference-rating-options" aria-label={`${candidate.label} rating`}>
                    {PREFERENCE_RATINGS.map((option) => (
                      <button
                        aria-pressed={rating === option.id}
                        className={rating === option.id ? `active ${option.id}` : option.id}
                        key={option.id}
                        type="button"
                        onClick={() => setRatings((current) => ({
                          ...current,
                          [candidate.attemptId]: option.id,
                        }))}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="labs-dataset-detail-actions">
            <button
              className="training-button"
              disabled={completedRatings !== candidateIds.length || training.busyAction !== null}
              type="button"
              onClick={() => void submit()}
            >
              Submit review
            </button>
            <button
              className="training-button secondary"
              disabled={training.busyAction !== null}
              type="button"
              onClick={() => setRatings(Object.fromEntries(candidateIds.map((candidateId) => [candidateId, "reject"] as const)))}
            >
              Reject all
            </button>
          </div>
          <div className="training-question-answer">
            <input aria-label="Unreviewable reason" placeholder="Why is this comparison unreviewable?" value={reason} onChange={(event) => setReason(event.target.value)} />
            <button className="training-button secondary" disabled={!reason.trim() || training.busyAction !== null} type="button" onClick={() => void markUnreviewable()}>
              Mark unreviewable
            </button>
          </div>
        </>
      )}
      <h3>Saved review evidence</h3>
      <div className="labs-dataset-detail-actions">
        <button className="training-button secondary" type="button" onClick={() => void refreshDatasets()}>
          Refresh preference datasets
        </button>
      </div>
      {datasets ? (
        datasets.length ? (
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead><tr><th>Dataset release</th><th>Evidence</th><th>Groups</th><th>Pairs</th></tr></thead>
              <tbody>{datasets.map((dataset) => (
                <tr key={dataset.id}>
                  <td><code>{dataset.id}</code></td>
                  <td>{dataset.authority === "human" ? "Human held-out" : "Fixture smoke only"}</td>
                  <td>{dataset.groups.length} ({dataset.groups.filter((group) => group.partition === "reward_train").length} train / {dataset.groups.filter((group) => group.partition === "reward_validation").length} validation)</td>
                  <td>{dataset.derivedPairs.length}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="labs-detail-copy">No immutable preference dataset has been materialized yet.</p>
      ) : null}
      <details className="labs-dataset-advanced-details">
        <summary>Prepare review batches and calibrate a judge</summary>
      <p className="labs-detail-copy">
        One managed batch creates one four-candidate human assignment. Repeat the generate, sync, and rank flow until the human target is reached; the target does not generate or approve comparisons automatically.
      </p>
      <div className="training-question-answer">
        <textarea
          aria-label="Preference calibration rubric"
          placeholder="Immutable comparison rubric"
          value={rubric}
          onChange={(event) => setRubric(event.target.value)}
        />
        <input
          aria-label="Minimum calibration samples"
          min={1}
          type="number"
          value={minimumSamples}
          onChange={(event) => setMinimumSamples(Math.max(1, Number.parseInt(event.target.value || "1", 10)))}
        />
        <div className="labs-dataset-detail-actions">
          <button
            className="training-button"
            disabled={!rubric.trim() || training.busyAction !== null || calibrationJobId !== null}
            type="button"
            onClick={() => void startCalibrationBatch()}
          >
            Generate 1 comparison (4 candidates)
          </button>
          <button
            className="training-button secondary"
            disabled={!calibrationJobId || training.busyAction !== null}
            type="button"
            onClick={() => void syncCalibrationBatch()}
          >
            Sync candidate batch
          </button>
          <button className="training-button secondary" type="button" onClick={() => void refreshCalibration()}>
            Refresh calibration
          </button>
          <button
            className="training-button secondary"
            disabled={!rubric.trim() || training.busyAction !== null || !calibration?.humanCompleted}
            type="button"
            onClick={() => void runNextModelReview()}
          >
            Run next model review
          </button>
          <button
            className="training-button"
            disabled={!calibration?.readyToFinalize || training.busyAction !== null}
            type="button"
            onClick={() => void finalizeCalibration()}
          >
            Save calibration report
          </button>
        </div>
      </div>
      {calibration ? (
        <p className="labs-detail-copy" role="status">
          Human {calibration.humanCompleted}/{calibration.minimumSamples ?? 0} · Model {calibration.canonicalModelCompleted}/{calibration.minimumSamples ?? 0} · Swapped {calibration.swappedModelCompleted}/{calibration.minimumSamples ?? 0}
          {calibration.latestReport ? ` · ${calibration.latestReport.passed ? "Passed" : "Failed"} (${Math.round(calibration.latestReport.orderAgreement * 100)}% order, ${Math.round(calibration.latestReport.tieAgreement * 100)}% ties, ${Math.round(calibration.latestReport.orderSwapAgreement * 100)}% swap)` : ""}
        </p>
      ) : null}
      {calibrationMessage ? <p className="labs-detail-copy" role="status">{calibrationMessage}</p> : null}
      </details>
    </DetailSection>
  );
}
