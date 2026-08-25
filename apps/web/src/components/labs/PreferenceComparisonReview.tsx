import { useEffect, useMemo, useState } from "react";
import type { ChatModelRef } from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { DetailSection } from "../training/DetailSection";

export function PreferenceComparisonReview({
  tasksetId,
  reviewerKey,
  defaultModel,
  defaultRubric,
  training,
}: {
  tasksetId: string;
  reviewerKey: string;
  defaultModel: ChatModelRef;
  defaultRubric: string;
  training: ReturnType<typeof useTraining>;
}) {
  const [review, setReview] = useState<Awaited<ReturnType<typeof training.actions.nextPreferenceComparison>>>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [ranked, setRanked] = useState<string[][]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [rubric, setRubric] = useState(defaultRubric);
  const [minimumSamples, setMinimumSamples] = useState(10);
  const [calibrationJobId, setCalibrationJobId] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<Awaited<ReturnType<typeof training.actions.preferenceCalibrationStatus>>>(null);
  const [calibrationMessage, setCalibrationMessage] = useState<string | null>(null);
  const orderedLabels = useMemo(() => review?.candidates.map((candidate) => candidate.label) ?? [], [review]);
  const rankedLabels = useMemo(() => new Set(ranked.flat()), [ranked]);

  useEffect(() => () => {
    for (const url of Object.values(previewUrls)) URL.revokeObjectURL(url);
  }, [previewUrls]);

  async function loadNext(): Promise<void> {
    for (const url of Object.values(previewUrls)) URL.revokeObjectURL(url);
    setPreviewUrls({});
    setRanked([]);
    setReason("");
    const next = await training.actions.nextPreferenceComparison(tasksetId, reviewerKey);
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

  async function submit(rejectAll: boolean): Promise<void> {
    if (!review || !startedAt) return;
    const result = await training.actions.submitPreferenceComparison({
      tasksetId,
      assignmentId: review.assignment.id,
      reviewerKey,
      order: rejectAll ? [] : ranked,
      rejectAll,
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
    <DetailSection title="Preference review">
      <p className="labs-detail-copy">
        Rank the presented outputs in visual or textual quality. Candidate identities are hidden; your order becomes immutable comparison evidence.
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
            Generate 4 candidates
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
      {review === null ? (
        <button className="training-button secondary" type="button" onClick={() => void loadNext()}>
          Open next comparison
        </button>
      ) : (
        <>
          {review.taskPrompt ? <pre className="labs-detail-copy">{JSON.stringify(review.taskPrompt, null, 2)}</pre> : null}
          <div className="labs-dataset-grader-list">
            {review.candidates.map((candidate) => {
              const rank = ranked.findIndex((group) => group.includes(candidate.label));
              const remaining = !rankedLabels.has(candidate.label);
              return (
                <div key={candidate.label}>
                  <strong>{candidate.label}</strong>
                  <small>{rank >= 0 ? `Rank ${rank + 1}` : "Unranked"}</small>
                  {candidate.artifacts.map((artifact) => previewUrls[artifact.id] ? (
                    <img
                      alt={`${candidate.label} artifact`}
                      key={artifact.id}
                      src={previewUrls[artifact.id]}
                      style={{ display: "block", maxWidth: "100%", maxHeight: 320, objectFit: "contain" }}
                    />
                  ) : null)}
                  <pre className="labs-detail-copy">{JSON.stringify(candidate.output, null, 2)}</pre>
                  {remaining ? (
                    <div className="labs-dataset-detail-actions">
                      <button
                        className="training-button secondary"
                        type="button"
                        onClick={() => setRanked((current) => [...current, [candidate.label]])}
                      >
                        Choose as next rank
                      </button>
                      {ranked.length ? (
                        <button
                          className="training-button secondary"
                          type="button"
                          onClick={() => setRanked((current) => [
                            ...current.slice(0, -1),
                            [...current[current.length - 1]!, candidate.label],
                          ])}
                        >
                          Tie previous rank
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="labs-dataset-detail-actions">
            <button
              className="training-button"
              disabled={rankedLabels.size !== orderedLabels.length || training.busyAction !== null}
              type="button"
              onClick={() => void submit(false)}
            >
              Submit ranking
            </button>
            <button className="training-button secondary" disabled={training.busyAction !== null} type="button" onClick={() => void submit(true)}>
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
    </DetailSection>
  );
}
