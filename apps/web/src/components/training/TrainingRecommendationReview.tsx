import { useEffect, useState } from "react";
import {
  conciseWorkproductName,
  type TaskCreationSnapshot,
  type TrainingSourceRef,
} from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingRecommendationReview({
  creation,
  resourceIntent = "workproduct",
  sources,
  training,
  onCreationChange,
}: {
  creation: TaskCreationSnapshot;
  resourceIntent?: TaskCreationSnapshot["request"]["resourceIntent"];
  sources: TrainingSourceRef[];
  training: TrainingController;
  onCreationChange: (creation: TaskCreationSnapshot) => void;
}) {
  const [revision, setRevision] = useState("");
  const proposal = creation.proposal;
  const [name, setName] = useState(proposal?.name ?? "");
  useEffect(() => setName(proposal?.name ?? ""), [proposal?.name]);
  if (!proposal) return null;
  const diagnosis = proposal.diagnosis;
  const recommendedTarget = resourceIntent === "dataset"
    ? "dataset"
    : targetKindForCreation(creation);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const trainingExamples = proposal.proposedExamples.filter((example) => example.split === "train");
  const evaluationExamples = proposal.proposedExamples.filter((example) => example.split !== "train");
  const graderAudit = creation.materializedTasksetId
    ? training.payload?.graderAuditReports.find((report) => report.tasksetId === creation.materializedTasksetId) ?? null
    : null;
  const primaryMethod = proposal.trainingPath?.primaryMethod ?? proposal.proposedMethod;

  async function revise() {
    const instruction = revision.trim();
    if (!instruction) return;
    const updated = await training.actions.chatCreation(creation.id, instruction);
    if (!updated) return;
    setRevision("");
    onCreationChange(updated);
  }

  async function saveName() {
    if (!proposal) return;
    const nextName = conciseWorkproductName(name, proposal.name);
    if (!nextName || nextName === proposal.name) return;
    const updated = await training.actions.renameCreation(creation.id, nextName);
    if (updated) {
      setName(updated.proposal?.name ?? nextName);
      onCreationChange(updated);
    }
  }

  return (
    <div className="training-recommendation-review">
      <section className="training-setup-section training-setup-model">
        <div className="training-setup-section-heading">
          <span className="training-setup-step-number">1</span>
          <strong>{recommendedTarget === "dataset" ? "Dataset" : "Model"}</strong>
          <small>{capitalize(recommendedTarget)} · {interventionLabel(diagnosis.intervention)}</small>
        </div>
        <label className="training-recommendation-name">
          <span>{recommendedTarget === "dataset" ? "Dataset name" : recommendedTarget === "model" ? "Model name" : "Workproduct name"}</span>
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} onBlur={() => void saveName()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveName(); } }} />
          <small>Five words maximum. The full capability stays in the description.</small>
        </label>
        <p className="training-recommendation-objective">{proposal.objective}</p>
        {recommendedTarget === "model" && creation.request.preferredBaseModelId ? (
          <p className="training-recommendation-base-model">
            <span>Preferred base</span>
            <strong>{shortModelName(creation.request.preferredBaseModelId)}</strong>
          </p>
        ) : null}
      </section>

      <details className="training-setup-section">
        <summary>
          <span className="training-setup-step-number">2</span>
          <strong>Dataset &amp; Evals</strong>
          <small>{trainingExamples.length} train · {evaluationExamples.length} eval · {proposal.proposedGraders.length} grader{proposal.proposedGraders.length === 1 ? "" : "s"}</small>
        </summary>
        <div className="training-recommendation-detail-body">
          <dl className="training-recommendation-facts">
            <div><dt>Chat seeds</dt><dd>{creation.request.sourceIds.length}</dd></div>
            <div><dt>Training examples</dt><dd>{trainingExamples.length}</dd></div>
            <div><dt>Evaluation examples</dt><dd>{evaluationExamples.length}</dd></div>
            <div><dt>Grader</dt><dd>{graderAudit ? graderAudit.passed ? "Passed" : "Failed" : proposal.proposedGraders.length ? "Runs after creation" : "Not proposed"}</dd></div>
          </dl>
          {proposal.proposedExamples.length ? (
            <div className="training-proposed-examples">
              {proposal.proposedExamples.map((example) => (
                <article key={example.id}>
                  <div><strong>{example.split === "frozen_eval" ? "Evaluation" : example.split === "train" ? "Training" : capitalize(example.split)}</strong><span>{capitalize(example.origin.replaceAll("_", " "))}</span></div>
                  <p>{example.inputPrompt}</p>
                  <small>{sourceById.get(example.sourceId)?.title ?? "Selected chat"}</small>
                </article>
              ))}
            </div>
          ) : <p>No training examples are proposed for this recommendation.</p>}
          {proposal.proposedGraders.length ? (
            <div className="training-proposed-evaluation">
              <strong>Grader summary</strong>
              <p>{proposal.proposedGraders.map((grader) => grader.label).join(", ")} · {graderAudit ? graderAudit.passed ? "executed successfully" : "execution failed" : "execution pending Taskset creation"}</p>
            </div>
          ) : null}
          {proposal.warnings.length && creation.state !== "recommendation_ready" ? <ul className="training-recommendation-warnings">{proposal.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
        </div>
      </details>

      <details className="training-setup-section" open>
        <summary>
          <span className="training-setup-step-number">3</span>
          <strong>Recommended training</strong>
          <small>{trainingMethodLabel(primaryMethod)}</small>
        </summary>
        <div className="training-recommendation-detail-body training-path-review">
          <div>
            <strong>Primary · {trainingMethodLabel(primaryMethod)}</strong>
            <p>{diagnosis.rationale.join(" ") || diagnosis.summary}</p>
          </div>
          {proposal.trainingPath?.bootstrap ? (
            <div>
              <strong>Optional precursor · Supervised / SFT</strong>
              <p>{proposal.trainingPath.bootstrap.demonstrationRefs.length} reviewed demonstration{proposal.trainingPath.bootstrap.demonstrationRefs.length === 1 ? "" : "s"}. {proposal.trainingPath.bootstrap.limitations.join(" ")}</p>
            </div>
          ) : null}
          <p className="training-setup-spend-note">Creating the model saves this Dataset and recommendation locally. Paid provider training starts later from the model’s Training page, where method, budget, and export are reviewed explicitly.</p>
        </div>
      </details>

      <details className="training-setup-section">
        <summary>
          <span className="training-setup-step-number">4</span>
          <strong>Behavior &amp; context</strong>
          <small>{diagnosis.stableBehavior.length} stable behavior{diagnosis.stableBehavior.length === 1 ? "" : "s"}</small>
        </summary>
        <div className="training-recommendation-detail-body">
          <h4>What it should learn</h4>
          {diagnosis.stableBehavior.length ? <ul>{diagnosis.stableBehavior.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{diagnosis.summary}</p>}
          {diagnosis.changingKnowledge.length || diagnosis.requiredContext.length ? (
            <>
              <h4>Keep in context</h4>
              <ul>{[...diagnosis.changingKnowledge, ...diagnosis.requiredContext].map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          ) : null}
        </div>
      </details>

      <details className="training-setup-section">
        <summary>
          <span className="training-setup-step-number">5</span>
          <strong>Advanced</strong>
          <small>Technical method · revise</small>
        </summary>
        <div className="training-recommendation-detail-body training-recommendation-revision">
          <p>Technical method: {technicalMethodLabel(primaryMethod)}</p>
          {creation.state === "recommendation_ready" || !diagnosis.trainingEligible ? (
            <div className="training-recommendation-guidance">
              <strong>Why this is not ready for a Dataset</strong>
              <ul>{proposal.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          ) : null}
          <textarea value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="Explain what should change" />
          <button className="training-button secondary" type="button" disabled={!revision.trim() || Boolean(training.busyAction)} onClick={() => void revise()}>Revise</button>
        </div>
      </details>
    </div>
  );
}

function targetKindForCreation(creation: TaskCreationSnapshot): "agent" | "skill" | "extension" | "model" | "configuration" {
  if (creation.request.targetIntent.kind) return creation.request.targetIntent.kind;
  if (creation.proposal?.diagnosis.trainingEligible) return "model";
  if (creation.proposal?.diagnosis.intervention === "retrieval") return "configuration";
  return "agent";
}

export function interventionLabel(value: TaskCreationSnapshot["proposal"] extends infer _Proposal ? NonNullable<TaskCreationSnapshot["proposal"]>["diagnosis"]["intervention"] : never): string {
  const labels = {
    no_training: "No training",
    prompting: "Prompt or agent instructions",
    retrieval: "Retrieval",
    sft: "SFT",
    preference: "Preference tuning",
    grpo_rft: "RFT",
    sdft_opsd: "Distillation",
    sdpo: "SDPO",
    agentic_rl: "Agentic RL",
  } as const;
  return labels[value];
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function trainingMethodLabel(value: string): string {
  if (value === "grpo") return "Reinforcement / RFT";
  if (value === "sft") return "Supervised / SFT";
  if (value === "preference") return "Preference";
  return capitalize(value.replaceAll("_", " "));
}

function technicalMethodLabel(value: string): string {
  if (value === "grpo") return "GRPO optimizer";
  if (value === "sft") return "SFT";
  return value.toUpperCase();
}

function shortModelName(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
}
