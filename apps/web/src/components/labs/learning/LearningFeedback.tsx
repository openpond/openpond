import { useState } from "react";
import { learningRef, type OpenPondLearningClient, type TaskAdmissionDecision, type TaskEvidence, type TaskFeedbackSubmission } from "openpond-sdk/learning";
import { LearningActions, LearningError, LearningJsonField, LearningPager, LearningValue, parseLearningObject } from "./LearningFields";
import { learningOperationId, useLearningMutation, useLearningResources } from "./useLearningResources";
import { useDraftNavigation } from "../useDraftNavigation";

export function LearningFeedback({ client, evidence, decision, onChanged, onTarget }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; decision: TaskAdmissionDecision | null; onChanged: () => void; onTarget: (value: Record<string, unknown>) => void }) {
  const [after, setAfter] = useState<string | null>(null);
  const feedback = useLearningResources(client, "feedback", { parentId: evidence.id, limit: 20, ...(after ? { afterId: after } : {}) }, true);
  const [kind, setKind] = useState<TaskFeedbackSubmission["kind"]>("target_correction");
  const [value, setValue] = useState("{}");
  const [note, setNote] = useState("");
  const mutation = useLearningMutation(client);
  const guard = useDraftNavigation({ name: "feedback", dirty: value !== "{}" || note !== "", busy: mutation.busy, save });
  async function save() {
    const result = await mutation.run((api) => api.submitFeedback({ schemaVersion: "openpond.taskFeedback.v1", sourceId: evidence.submission.sourceId, exampleId: evidence.submission.exampleId, attemptId: evidence.submission.attemptId, idempotencyKey: learningOperationId(), expectedEvidenceHash: evidence.contentHash, occurredAt: new Date().toISOString(), kind, value: parseLearningObject(value), note }));
    if (result) { feedback.refresh(); setValue("{}"); setNote(""); }
    return Boolean(result);
  }
  return <section className="learning-feedback"><h2>Feedback and corrections</h2><p>Input, ground-truth and family corrections create a new evidence revision. Grade and review that revision before sealing it.</p>
    <LearningError error={mutation.error ?? feedback.error} />
    <label>Feedback type<select value={kind} onChange={(event) => setKind(event.target.value as TaskFeedbackSubmission["kind"])}><option value="target_correction">Proposed supervised target</option><option value="ground_truth_correction">Correct expected answer</option><option value="input_correction">Correct task input</option><option value="family_resolution">Resolve family</option><option value="outcome">Outcome evidence</option></select></label>
    <LearningJsonField label="Feedback value" value={value} onChange={setValue} hint={kind === "family_resolution" ? 'Use {"familyKey":"stable-source-family"}.' : undefined} />
    <label>Feedback note<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void save(); }}>Save feedback for review</button></LearningActions>
    {feedback.page?.items.map((entry) => <article className="learning-feedback-entry" key={entry.id}><h3>{entry.submission.kind.replaceAll("_", " ")}</h3><p>{entry.status} · {entry.submission.occurredAt}</p><p>{entry.submission.note}</p><LearningValue label="Proposed value" value={entry.submission.value} />
      {entry.status === "pending_review" ? entry.submission.kind === "target_correction" ? <button type="button" className="training-button secondary" onClick={() => onTarget(entry.submission.value)}>Use as proposed target for grading</button> : ["ground_truth_correction", "input_correction", "family_resolution"].includes(entry.submission.kind) ? <button type="button" className="training-button secondary" disabled={mutation.busy} onClick={async () => { if (await mutation.command({ action: "apply_correction", operationId: learningOperationId(), feedbackId: entry.id, evidence: learningRef(evidence) })) onChanged(); }}>Apply correction as new evidence revision</button> : <p>Use this outcome when making the evidence review decision above.</p> : null}
      {entry.status === "pending_review" ? <LearningActions>{decision && ["outcome", "target_correction"].includes(entry.submission.kind) ? <button type="button" className="training-button secondary" disabled={mutation.busy} onClick={async () => { if (await mutation.command({ action: "resolve_feedback", operationId: learningOperationId(), feedbackId: entry.id, expectedRevision: entry.revision, disposition: "applied", decision: learningRef(decision), note: "Applied the current evidence review to this feedback." })) feedback.refresh(); }}>Resolve with current review</button> : null}<button type="button" className="training-button secondary" disabled={mutation.busy} onClick={async () => { if (await mutation.command({ action: "resolve_feedback", operationId: learningOperationId(), feedbackId: entry.id, expectedRevision: entry.revision, disposition: "rejected", decision: null, note: "Rejected by the reviewer." })) feedback.refresh(); }}>Reject feedback</button></LearningActions> : null}
      {entry.review ? <p>Resolved by {entry.review.actorId}: {entry.review.note}</p> : null}
    </article>)}
    <LearningPager after={after} next={feedback.page?.nextCursor} onPage={setAfter} />
    {guard.dialog}
  </section>;
}
