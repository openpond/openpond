import { useState } from "react";
import type { AppPreferences, ChatModelRef, CodexReasoningEffort } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { trainingAuthoringModel } from "./training-flow";

type TrainingController = ReturnType<typeof useTraining>;
type Candidate = NonNullable<TrainingController["payload"]>["candidates"][number];

export function TrainingSuggestions({
  training,
  defaultModel,
  preferences,
  reasoningEffort,
  onPlanStarted,
}: {
  training: TrainingController;
  defaultModel: ChatModelRef;
  preferences: AppPreferences["training"];
  reasoningEffort: CodexReasoningEffort;
  onPlanStarted: () => void;
}) {
  const candidates = training.payload?.candidates ?? [];
  return (
    <section className="training-page-body training-suggestions">
      <div>
        <h2>AI suggestions</h2>
        <p>Review repeated work found by the local Task Miner before creating a training plan.</p>
      </div>
      {candidates.length ? (
        <div className="training-card-grid">
          {candidates.map((candidate) => (
            <SuggestionCard
              key={candidate.id}
              candidate={candidate}
              candidates={candidates}
              training={training}
              defaultModel={defaultModel}
              preferences={preferences}
              reasoningEffort={reasoningEffort}
              onPlanStarted={onPlanStarted}
            />
          ))}
        </div>
      ) : (
        <div className="training-empty training-suggestions-empty">
          No AI suggestions yet. Start New model with Automatic to scan selected chats for repeated, verifiable work.
        </div>
      )}
    </section>
  );
}

function SuggestionCard({
  candidate,
  candidates,
  training,
  defaultModel,
  preferences,
  reasoningEffort,
  onPlanStarted,
}: {
  candidate: Candidate;
  candidates: Candidate[];
  training: TrainingController;
  defaultModel: ChatModelRef;
  preferences: AppPreferences["training"];
  reasoningEffort: CodexReasoningEffort;
  onPlanStarted: () => void;
}) {
  const [mergeIntoId, setMergeIntoId] = useState("");
  const mergeTargets = candidates.filter((item) => item.id !== candidate.id && item.status !== "retired");

  async function createPlan() {
    const creation = await training.actions.createCandidate(
      candidate.id,
      preferences.creationMode,
      trainingAuthoringModel(preferences, defaultModel),
      reasoningEffort,
    );
    if (!creation) return;
    if (creation.state === "awaiting_disclosure_approval" && preferences.autoApproveEvidence) {
      await training.actions.approveDisclosure(creation.id, true);
    }
    onPlanStarted();
  }

  return (
    <article className="training-card">
      <div className="training-card-heading">
        <strong>{candidate.title}</strong>
        <span className="training-pill">{candidate.recommendation.tactic.replaceAll("_", " ")}</span>
      </div>
      <p>{candidate.summary}</p>
      <dl>
        <div><dt>Frequency</dt><dd>{percent(candidate.scorecard.frequency)}</dd></div>
        <div><dt>Verifiable</dt><dd>{percent(candidate.scorecard.verifiability)}</dd></div>
        <div><dt>Signal</dt><dd>{percent(candidate.scorecard.signalQuality)}</dd></div>
      </dl>
      <details className="training-evidence">
        <summary>Evidence and recommendation</summary>
        <p>{candidate.recommendation.reasons.join(" ")}</p>
        {candidate.recommendation.blockers.map((blocker) => (
          <p key={blocker} className="training-draft-warning">{blocker}</p>
        ))}
        <ul>
          {candidate.evidence.map((item) => (
            <li key={item.id}>
              <strong>{item.kind.replaceAll("_", " ")}</strong> — {item.summary} ({percent(item.confidence)})
            </li>
          ))}
        </ul>
      </details>
      <div className="training-inline-actions">
        <button className="training-button" type="button" disabled={Boolean(training.busyAction)} onClick={() => void createPlan()}>Create plan</button>
        <button className="training-text-button" type="button" onClick={() => void training.actions.patchCandidate(candidate.id, { status: "rejected" })}>Reject</button>
        <button className="training-text-button" type="button" onClick={() => void training.actions.patchCandidate(candidate.id, { status: "dismissed" })}>Dismiss</button>
      </div>
      {mergeTargets.length ? (
        <div className="training-merge-row">
          <select aria-label={`Merge ${candidate.title} into`} value={mergeIntoId} onChange={(event) => setMergeIntoId(event.target.value)}>
            <option value="">Merge into…</option>
            {mergeTargets.map((target) => <option value={target.id} key={target.id}>{target.title}</option>)}
          </select>
          <button className="training-text-button" type="button" disabled={!mergeIntoId} onClick={() => void training.actions.patchCandidate(candidate.id, { mergeIntoId })}>Merge</button>
        </div>
      ) : null}
    </article>
  );
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}
