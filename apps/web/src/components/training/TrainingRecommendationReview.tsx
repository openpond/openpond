import { useEffect, useState } from "react";
import type { TaskCreationSnapshot, TrainingSourceRef } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingRecommendationReview({
  creation,
  sources,
  training,
  onCreationChange,
}: {
  creation: TaskCreationSnapshot;
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
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const trainingExamples = proposal.proposedExamples.filter((example) => example.split === "train");
  const evaluationExamples = proposal.proposedExamples.filter((example) => example.split === "frozen_eval");
  const graderAudit = creation.materializedTasksetId
    ? training.payload?.graderAuditReports.find((report) => report.tasksetId === creation.materializedTasksetId) ?? null
    : null;

  async function revise() {
    const instruction = revision.trim();
    if (!instruction) return;
    const updated = await training.actions.chatCreation(creation.id, instruction);
    if (!updated) return;
    setRevision("");
    onCreationChange(updated);
  }

  async function saveName() {
    const nextName = name.trim();
    if (!proposal || !nextName || nextName === proposal.name) return;
    const updated = await training.actions.renameCreation(creation.id, nextName);
    if (updated) onCreationChange(updated);
  }

  return (
    <div className="training-recommendation-review">
      <div className="training-recommendation-heading">
        <label className="training-recommendation-name"><span>Model name</span><input value={name} maxLength={500} onChange={(event) => setName(event.target.value)} onBlur={() => void saveName()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveName(); } }} /></label>
        <span>{interventionLabel(diagnosis.intervention)}</span>
      </div>
      <p className="training-recommendation-objective">{proposal.objective}</p>

      <dl className="training-recommendation-facts">
        <div><dt>Training examples</dt><dd>{trainingExamples.length}</dd></div>
        <div><dt>Evaluation examples</dt><dd>{evaluationExamples.length}</dd></div>
        <div><dt>Grader</dt><dd>{graderAudit ? graderAudit.passed ? "Passed" : "Failed" : proposal.proposedGraders.length ? "Not run yet" : "Not proposed"}</dd></div>
      </dl>

      {proposal.trainingPath ? <section className="training-path-review">
        <h4>Training path</h4>
        <div><strong>Primary · {proposal.trainingPath.primaryMethod.toUpperCase()}</strong><p>{diagnosis.rationale.join(" ")}</p></div>
        {proposal.trainingPath.bootstrap ? <div><strong>Optional precursor · SFT trajectory bootstrap</strong><p>{proposal.trainingPath.bootstrap.demonstrationRefs.length} reviewed demonstration{proposal.trainingPath.bootstrap.demonstrationRefs.length === 1 ? "" : "s"}. {proposal.trainingPath.bootstrap.limitations.join(" ")}</p></div> : null}
      </section> : null}

      <section>
        <h4>What it should learn</h4>
        {diagnosis.stableBehavior.length ? <ul>{diagnosis.stableBehavior.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{diagnosis.summary}</p>}
      </section>

      {diagnosis.changingKnowledge.length || diagnosis.requiredContext.length ? (
        <section>
          <h4>Keep in context</h4>
          <ul>
            {[...diagnosis.changingKnowledge, ...diagnosis.requiredContext].map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ) : null}

      {creation.state === "recommendation_ready" || !diagnosis.trainingEligible ? (
        <section className="training-recommendation-guidance">
          <h4>Why this is not ready for a Taskset</h4>
          <ul>{proposal.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </section>
      ) : null}

      <details className="training-recommendation-details">
        <summary>Review examples and evaluation</summary>
        <div className="training-recommendation-detail-body">
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

      <details className="training-recommendation-details">
        <summary>Revise recommendation</summary>
        <div className="training-recommendation-revision">
          <textarea value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="Explain what should change" />
          <button className="training-button secondary" type="button" disabled={!revision.trim() || Boolean(training.busyAction)} onClick={() => void revise()}>Revise</button>
        </div>
      </details>
    </div>
  );
}

export function interventionLabel(value: TaskCreationSnapshot["proposal"] extends infer _Proposal ? NonNullable<TaskCreationSnapshot["proposal"]>["diagnosis"]["intervention"] : never): string {
  const labels = {
    no_training: "No training",
    prompting: "Prompt or agent instructions",
    retrieval: "Retrieval",
    sft: "SFT",
    preference: "Preference tuning",
    grpo_rft: "GRPO / RFT",
    sdft_opsd: "Distillation",
    sdpo: "SDPO",
    agentic_rl: "Agentic RL",
  } as const;
  return labels[value];
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
