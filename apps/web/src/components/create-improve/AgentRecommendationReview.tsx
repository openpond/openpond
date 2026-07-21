import { useState } from "react";
import type { TaskCreationSnapshot, TrainingSourceRef } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";

type TrainingController = ReturnType<typeof useTraining>;

export function AgentRecommendationReview({
  creation,
  onCreationChange,
  sources,
  training,
}: {
  creation: TaskCreationSnapshot;
  onCreationChange: (creation: TaskCreationSnapshot) => void;
  sources: TrainingSourceRef[];
  training: TrainingController;
}) {
  const [revision, setRevision] = useState("");
  const proposal = creation.proposal;
  if (!proposal) return null;

  const selectedSourceIds = new Set(creation.request.sourceIds);
  const selectedSources = sources.filter((source) => selectedSourceIds.has(source.id));
  const behaviors = proposal.diagnosis.stableBehavior.length > 0
    ? proposal.diagnosis.stableBehavior
    : [proposal.diagnosis.summary];
  const context = [
    ...proposal.diagnosis.changingKnowledge,
    ...proposal.diagnosis.requiredContext,
  ];
  const reviewScenarios = proposal.proposedExamples.filter(
    (example) => example.split !== "train",
  );
  const operationLabel = creation.request.targetIntent.operation === "improve"
    ? "Improvement"
    : "New Agent";

  async function revise() {
    const instruction = revision.trim();
    if (!instruction) return;
    const updated = await training.actions.chatCreation(creation.id, instruction);
    if (!updated) return;
    setRevision("");
    onCreationChange(updated);
  }

  return (
    <div className="training-recommendation-review agent-recommendation-review">
      <section className="training-setup-section training-setup-model">
        <div className="training-setup-section-heading">
          <span className="training-setup-step-number">1</span>
          <strong>Purpose</strong>
          <small>{operationLabel}</small>
        </div>
        <div className="training-recommendation-detail-body">
          <p className="training-recommendation-objective">
            {creation.request.objective ?? proposal.objective}
          </p>
        </div>
      </section>

      <details className="training-setup-section" open>
        <summary>
          <span className="training-setup-step-number">2</span>
          <strong>What the Agent should do</strong>
          <small>{behaviors.length} expected behavior{behaviors.length === 1 ? "" : "s"}</small>
        </summary>
        <div className="training-recommendation-detail-body">
          <ul>{behaviors.map((behavior) => <li key={behavior}>{behavior}</li>)}</ul>
          {context.length > 0 ? (
            <>
              <h4>Information it should use at run time</h4>
              <ul>{context.map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          ) : null}
        </div>
      </details>

      <details className="training-setup-section">
        <summary>
          <span className="training-setup-step-number">3</span>
          <strong>Supporting chats</strong>
          <small>{selectedSources.length} selected</small>
        </summary>
        <div className="training-recommendation-detail-body">
          {selectedSources.length > 0 ? (
            <ul>{selectedSources.map((source) => <li key={source.id}>{source.title}</li>)}</ul>
          ) : (
            <p>No chats are attached. OpenPond will build from the purpose above.</p>
          )}
        </div>
      </details>

      <details className="training-setup-section">
        <summary>
          <span className="training-setup-step-number">4</span>
          <strong>Evals</strong>
          <small>{reviewScenarios.length} Eval scenario{reviewScenarios.length === 1 ? "" : "s"}</small>
        </summary>
        <div className="training-recommendation-detail-body">
          <p>
            OpenPond will evaluate the Agent against scenarios derived from the
            approved chats before it can be released.
          </p>
          {reviewScenarios.length > 0 ? (
            <ul>
              {reviewScenarios.map((scenario) => (
                <li key={scenario.id}>{scenario.inputPrompt}</li>
              ))}
            </ul>
          ) : (
            <p>Add another supporting chat so OpenPond can keep a separate Eval scenario.</p>
          )}
        </div>
      </details>

      <details className="training-setup-section">
        <summary>
          <span className="training-setup-step-number">5</span>
          <strong>Change this review</strong>
          <small>Optional</small>
        </summary>
        <div className="training-recommendation-detail-body training-recommendation-revision">
          <textarea
            aria-label="Changes to the Agent review"
            onChange={(event) => setRevision(event.target.value)}
            placeholder="Explain what the Agent should do differently"
            value={revision}
          />
          <button
            className="training-button secondary"
            disabled={!revision.trim() || Boolean(training.busyAction)}
            onClick={() => void revise()}
            type="button"
          >
            Update review
          </button>
        </div>
      </details>

      {creation.state === "recommendation_ready" ? (
        <div className="training-recommendation-guidance">
          <strong>Add another example before continuing</strong>
          <p>
            OpenPond needs enough independent examples to evaluate the Agent without
            reusing the same conversation it learned from.
          </p>
        </div>
      ) : null}
    </div>
  );
}
