import { useEffect, useMemo, useState } from "react";

import type { useTraining } from "../../hooks/useTraining";
import { DetailSection } from "../training/DetailSection";

export function PreferenceComparisonReview({
  tasksetId,
  reviewerKey,
  training,
}: {
  tasksetId: string;
  reviewerKey: string;
  training: ReturnType<typeof useTraining>;
}) {
  const [review, setReview] = useState<Awaited<ReturnType<typeof training.actions.nextPreferenceComparison>>>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [ranked, setRanked] = useState<string[][]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
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

  return (
    <DetailSection title="Preference review">
      <p className="labs-detail-copy">
        Rank the presented outputs in visual or textual quality. Candidate identities are hidden; your order becomes immutable comparison evidence.
      </p>
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
              disabled={ranked.length !== orderedLabels.length || training.busyAction !== null}
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
