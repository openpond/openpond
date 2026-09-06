import { useState } from "react";
import { learningRef, inspectTaskEvidence, sameLearningRef, TaskAdmissionDecisionSchema, TaskGradeRunSchema, type OpenPondLearningClient, type TaskEvidence, type TaskGradeRun } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningActions, LearningError, LearningJsonField, LearningPager, LearningValue, parseLearningObject } from "./LearningFields";
import { learningOperationId, useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";
import { LearningFeedback } from "./LearningFeedback";
import { useDraftNavigation } from "../useDraftNavigation";

export function LearningReviewPage({ client, selectedId, after, onSelect, onPage, onBatches }: { client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (cursor: string | null) => void; onBatches: () => void }) {
  const evidence = useLearningResources(client, "evidence", { limit: 30, ...(after ? { afterId: after } : {}) });
  if (selectedId) return <EvidenceLoader key={selectedId} client={client} id={selectedId} onBack={() => onSelect(null)} onBatches={onBatches} />;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title="Example review" description="Review task validity, observed response quality, and supervised-target approval independently. Evidence is shared across models in this workspace." actions={<button type="button" className="training-button secondary" onClick={onBatches}>Approved batches</button>} />
    <LearningError error={evidence.error} /><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Example</th><th>Source</th><th>Family / split</th><th>Revision</th></tr></thead><tbody>{evidence.page?.items.map((entry) => <tr key={entry.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(entry.id)}><strong>{entry.submission.exampleId}</strong><small>{entry.submission.attemptId}</small></button></td><td>{entry.submission.sourceId}</td><td>{entry.submission.familyKey ?? "Family unresolved"} · {entry.submission.split}</td><td>{entry.revision}</td></tr>)}</tbody></table></div>
    {evidence.loading ? <p role="status">Loading examples…</p> : !evidence.page?.items.length ? <p>Submit examples from Tasksets → Task formats to begin review.</p> : null}<LearningPager after={after} next={evidence.page?.nextCursor} onPage={onPage} />
  </div>;
}

function EvidenceLoader({ client, id, onBack, onBatches }: { client: OpenPondLearningClient | null; id: string; onBack: () => void; onBatches: () => void }) {
  const evidence = useLearningResource(client, "evidence", id);
  return evidence.resource ? <EvidenceReview key={`${id}:${evidence.resource.revision}`} client={client} evidence={evidence.resource} onBack={onBack} onBatches={onBatches} onChanged={evidence.refresh} /> : <div className="labs-flat-body labs-resource-page learning-workspace"><LearningError error={evidence.error} /><p role="status">{evidence.error ? "This example could not be opened." : "Loading example…"}</p><button type="button" className="training-button secondary" onClick={onBack}>Back to review</button></div>;
}

function EvidenceReview({ client, evidence, onBack, onBatches, onChanged }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; onBack: () => void; onBatches: () => void; onChanged: () => void }) {
  const definition = useLearningResource(client, "definition", evidence.submission.taskDefinition.id, evidence.submission.taskDefinition.revision);
  const [gradeAfter, setGradeAfter] = useState<string | null>(null);
  const grades = useLearningResources(client, "grade", { parentId: evidence.id, limit: 30, ...(gradeAfter ? { afterId: gradeAfter } : {}) }, true);
  const decisions = useLearningResources(client, "decision", { parentId: evidence.id, limit: 1 });
  const [target, setTarget] = useState("{}");
  const [observedGradeId, setObservedGradeId] = useState("");
  const [targetGradeId, setTargetGradeId] = useState("");
  const observedReceipt = useLearningResource(client, "grade", observedGradeId || null, undefined, true);
  const targetReceipt = useLearningResource(client, "grade", targetGradeId || null, undefined, true);
  const [queued, setQueued] = useState<TaskGradeRun[]>([]);
  const [note, setNote] = useState("");
  const [savedProposal, setSavedProposal] = useState(JSON.stringify({ target: "{}", note: "" }));
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useLearningMutation(client);
  const proposalSnapshot = JSON.stringify({ target, note });
  const proposalGuard = useDraftNavigation({ name: "review proposal", dirty: proposalSnapshot !== savedProposal, busy: mutation.busy, save: saveProposal });
  const inspection = definition.resource ? inspectTaskEvidence(evidence, definition.resource) : null;
  const gradeMap = new Map<string, TaskGradeRun>();
  for (const grade of [...queued, ...(grades.page?.items ?? []), observedReceipt.resource, targetReceipt.resource]) {
    if (grade && sameLearningRef(grade.evidence, learningRef(evidence)) && grade.revision >= (gradeMap.get(grade.id)?.revision ?? 0)) gradeMap.set(grade.id, grade);
  }
  const allGrades = [...gradeMap.values()];
  const observedGrade = allGrades.find((grade) => grade.id === observedGradeId) ?? null;
  const targetGrade = allGrades.find((grade) => grade.id === targetGradeId) ?? null;
  const decision = decisions.page?.items[0] ?? null;
  const currentDecision = decision && sameLearningRef(decision.evidence, learningRef(evidence)) ? decision : null;
  async function saveProposal() {
    const result = await mutation.run((api) => api.submitFeedback({ schemaVersion: "openpond.taskFeedback.v1", sourceId: evidence.submission.sourceId, exampleId: evidence.submission.exampleId, attemptId: evidence.submission.attemptId, idempotencyKey: learningOperationId(), expectedEvidenceHash: evidence.contentHash, occurredAt: new Date().toISOString(), kind: "target_correction", value: parseLearningObject(target), note }));
    if (result) { setSavedProposal(proposalSnapshot); setNotice("Proposal saved as feedback for this evidence revision. It still requires grading and approval."); }
    return Boolean(result);
  }
  async function grade(output: "observed" | "proposed_target") {
    const result = await mutation.run(async (api) => TaskGradeRunSchema.parse((await api.command({ action: "queue_grade", operationId: learningOperationId(), evidence: learningRef(evidence), target: output, proposedTarget: output === "observed" ? null : parseLearningObject(target), timeoutMs: 30_000, maximumSpendUsd: 0 })).resources[0]));
    if (result) { setQueued((previous) => [...previous, result]); (output === "observed" ? setObservedGradeId : setTargetGradeId)(result.id); grades.refresh(); }
  }
  async function review(disposition: "approved" | "rejected" | "pending", approveTarget: boolean) {
    const result = await mutation.run(async (api) => TaskAdmissionDecisionSchema.parse((await api.command({ action: "review", operationId: learningOperationId(), evidence: learningRef(evidence), expectedRevision: decision?.revision ?? 0, disposition, targetApproval: approveTarget ? "approved" : disposition === "rejected" ? "rejected" : "not_required", approvedTarget: approveTarget ? parseLearningObject(target) : null, observedGradeId: observedGrade?.status === "completed" ? observedGrade.id : null, targetGradeId: approveTarget ? targetGrade?.id ?? null : null, note })).resources[0]));
    if (result) { decisions.refresh(); if (approveTarget) setSavedProposal(proposalSnapshot); setNotice(`Task ${result.taskAdmissibility}; observed response ${result.observedQuality}; supervised target ${result.targetApproval}.`); }
  }
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={evidence.submission.exampleId} description={`Attempt ${evidence.submission.attemptId} · evidence release ${evidence.revision} · ${evidence.submission.split}`} actions={<button type="button" className="training-button secondary" onClick={onBack}>Back to review</button>} />
    <LearningError error={mutation.error ?? definition.error ?? decisions.error ?? grades.error ?? observedReceipt.error ?? targetReceipt.error} />{notice ? <p role="status">{notice}</p> : null}
    <p>Task: {inspection ? inspection.taskReady ? "Ready for grading and review" : "Needs correction" : "Loading contract…"}. Family: {evidence.submission.familyKey ?? "Unresolved"}.</p>
    {inspection?.issues.length ? <ul>{inspection.issues.map((issue, index) => <li key={index}>{issue.path}: {issue.message}</li>)}</ul> : null}
    {currentDecision ? <LearningValue label="Current decision" value={{ task: currentDecision.taskAdmissibility, observedResponse: currentDecision.observedQuality, supervisedTarget: currentDecision.targetApproval, reviewer: currentDecision.actor.id, note: currentDecision.note }} /> : <p>No decision exists for this evidence revision.</p>}
    <div className="learning-evidence-columns"><LearningValue label="Task input" value={evidence.submission.input} /><LearningValue label="Observed response" value={evidence.submission.observedOutput} /><LearningValue label="Expected answer (evaluator only)" value={evidence.submission.expected} /></div>
    <details><summary>Provenance and private evaluator context</summary><LearningValue label="Evaluator context" value={evidence.submission.evaluatorContext} /><LearningValue label="Provenance" value={{ source: evidence.source, ...evidence.submission.provenance, supersedes: evidence.supersedes }} /></details>
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy || !inspection?.taskReady || !evidence.submission.observedOutput} onClick={() => { void grade("observed"); }}>Grade observed response</button></LearningActions>
    <LearningJsonField label="Proposed supervised target" hint="Write the response the model should learn. It must pass its own grader run before you can approve it." value={target} onChange={(value) => { setTarget(value); setTargetGradeId(""); }} />
    <button type="button" className="training-button secondary" disabled={mutation.busy || !inspection?.taskReady} onClick={() => { void grade("proposed_target"); }}>Grade proposed target</button>
    <h2>Grader runs</h2><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Target</th><th>State</th><th>Result</th><th>Review receipt</th></tr></thead><tbody>{allGrades.map((grade) => <tr key={grade.id}><td>{grade.target === "observed" ? "Observed response" : "Proposed target"}</td><td>{grade.status}</td><td>{gradeSummary(grade)}</td><td>{grade.status === "completed" ? <button type="button" className="training-button secondary" onClick={() => { if (grade.target === "observed") setObservedGradeId(grade.id); else { setTarget(JSON.stringify(grade.output, null, 2)); setTargetGradeId(grade.id); } }}>{grade.id === observedGradeId || grade.id === targetGradeId ? "Selected" : "Use receipt"}</button> : ["queued", "running"].includes(grade.status) ? <button type="button" className="training-button secondary" disabled={mutation.busy} onClick={async () => { if (await mutation.command({ action: "cancel_grade", operationId: learningOperationId(), gradeId: grade.id, expectedRevision: grade.revision })) grades.refresh(); }}>Cancel</button> : null}</td></tr>)}</tbody></table></div>
    <LearningPager after={gradeAfter} next={grades.page?.nextCursor} onPage={setGradeAfter} />
    {targetGrade?.composition ? <details><summary>Inspect target grading receipt</summary><LearningValue label="Selected target grading evidence" value={targetGrade.composition} /></details> : null}
    <label>Review note<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" className="training-button secondary" disabled={mutation.busy || proposalSnapshot === savedProposal} onClick={() => { void saveProposal(); }}>Save proposal for later</button>
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy || decisions.loading} onClick={() => { void review("rejected", false); }}>Reject task</button><button type="button" className="training-button secondary" disabled={mutation.busy || decisions.loading} onClick={() => { void review("pending", false); }}>Keep pending</button><button type="button" className="training-button secondary" disabled={mutation.busy || decisions.loading || !inspection?.taskReady} onClick={() => { void review("approved", false); }}>Approve task only</button><button type="button" className="training-button" disabled={mutation.busy || decisions.loading || !inspection?.taskReady || !gradePassed(targetGrade)} onClick={() => { void review("approved", true); }}>Approve task and target</button></LearningActions>
    <p>Task-only approval permits a compatible reward-training or evaluation batch. Supervised training also requires an approved target.</p>
    <LearningFeedback client={client} evidence={evidence} decision={currentDecision} onChanged={() => { void proposalGuard.requestLeave(onChanged); }} onTarget={(target) => { setTarget(JSON.stringify(target, null, 2)); setTargetGradeId(""); }} />
    {currentDecision?.taskAdmissibility === "approved" ? <button type="button" className="training-button" onClick={onBatches}>Seal approved examples into a batch</button> : null}
    {proposalGuard.dialog}
  </div>;
}

function gradePassed(grade: TaskGradeRun | null) {
  if (grade?.status !== "completed" || !grade.composition) return false;
  const results = [grade.composition.training, grade.composition.evaluation].filter((result) => result.status !== "not_configured");
  return results.length > 0 && results.every((result) => result.status === "scored" && result.passed === true);
}
function gradeSummary(grade: TaskGradeRun) {
  if (grade.failure) return grade.failure;
  if (!grade.composition) return "No result recorded";
  return [grade.composition.training, grade.composition.evaluation].filter((result) => result.status !== "not_configured").map((result) => result.status === "scored" ? `${result.passed ? "Passed" : "Failed"} · ${result.score}` : result.status).join("; ");
}
