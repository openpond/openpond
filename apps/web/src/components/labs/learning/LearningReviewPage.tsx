import type { OpenPondLearningClient } from "openpond-sdk/learning";
import { useRef, useState } from "react";
import { learningRef, sameLearningRef, TaskAdmissionDecisionSchema, TaskGradeRunSchema, TaskRatingSchema, TaskFeedbackSchema, type TaskEvidence, type TaskGradeRun } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningActions, LearningError, LearningJsonField, LearningPager, LearningValue, parseLearningObject } from "./LearningFields";
import { learningOperationId, useLearningInspection, useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";
import { LearningFeedback } from "./LearningFeedback";
import { RewardCompositionDetails } from "./RewardCompositionView";
import { emptyTaskRating, TaskRatingFields } from "./TaskRatingFields";
import { useDraftNavigation } from "../useDraftNavigation";

export function LearningReviewPage({ canManage = true, client, selectedId, after, sourceId = null, onClearSource, onSelect, onPage, onBatches }: { canManage?: boolean; client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; sourceId?: string | null; onClearSource?: () => void; onSelect: (id: string | null) => void; onPage: (cursor: string | null) => void; onBatches?: () => void }) {
  const [reviewState, setReviewState] = useState<"inbox" | "reviewed">("inbox");
  const evidence = useLearningResources(client, "evidence", { reviewState, limit: 30, ...(sourceId ? { parentId: sourceId } : {}), ...(after ? { afterId: after } : {}) });
  const source = useLearningResource(client, "source", sourceId);
  if (selectedId) return <EvidenceLoader canManage={canManage} key={selectedId} client={client} id={selectedId} sourceId={sourceId} onBack={() => { evidence.refresh(); onSelect(null); }} onBatches={onBatches} />;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title="Labeling" description={sourceId ? `Review tasks from ${source.resource?.name ?? sourceId}. Task validity and target approval remain separate decisions.` : "Label observed responses, propose corrections, and approve tasks independently. Examples are shared across Models in this workspace."} actions={<><button type="button" className="training-button secondary" onClick={onBatches}>Approved batches</button>{sourceId && onClearSource ? <button type="button" className="training-button secondary" onClick={onClearSource}>All workspace examples</button> : null}</>} />
    <LearningActions>{(["inbox", "reviewed"] as const).map(state => <button key={state} type="button" className="training-button secondary" aria-pressed={reviewState === state} onClick={() => { setReviewState(state); onPage(null); }}>{state === "inbox" ? "Inbox" : "Reviewed"}</button>)}<button type="button" className="training-button" disabled={evidence.loading || !evidence.page?.items.length} onClick={() => { const next = evidence.page?.items[0]; if (next) onSelect(next.id); }}>Review next</button></LearningActions>
    <LearningError error={evidence.error ?? source.error} /><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Request</th><th>Source</th><th>Split</th><th>Attempt</th></tr></thead><tbody>{evidence.page?.items.map(entry => <EvidenceRow key={entry.id} client={client} evidence={entry} onSelect={onSelect} />)}</tbody></table></div>
    {evidence.loading ? <p role="status">Loading examples…</p> : !evidence.page?.items.length ? <p>No retained examples are available for labeling in this scope.</p> : null}<LearningPager after={after} next={evidence.page?.nextCursor} onPage={onPage} />
  </div>;
}

function EvidenceRow({ client, evidence, onSelect }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; onSelect: (id: string) => void }) {
  const source = useLearningResource(client, "source", evidence.source.id, evidence.source.revision);
  return <tr><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(evidence.id)}><strong>{requestSummary(evidence.submission.input) || "Open request"}</strong></button></td><td>{source.resource?.name ?? "Source"}<LearningError error={source.error} /></td><td>{evidence.submission.split}</td><td>{evidence.submission.attemptId}</td></tr>;
}
function requestSummary(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 180);
  if (!value || typeof value !== "object") return "";
  return Object.values(value).map(requestSummary).filter(Boolean).join(" · ").slice(0, 180);
}

function EvidenceLoader({ canManage, client, id, sourceId, onBack, onBatches }: { canManage: boolean; client: OpenPondLearningClient | null; id: string; sourceId: string | null; onBack: () => void; onBatches?: () => void }) {
  const evidence = useLearningResource(client, "evidence", id);
  if (evidence.resource && sourceId && evidence.resource.source.id !== sourceId) return <div className="learning-workspace"><LearningError error="This example does not belong to the selected source." /><button type="button" className="training-button secondary" onClick={onBack}>Back to review</button></div>;
  return evidence.resource ? <EvidenceReview canManage={canManage} key={`${id}:${evidence.resource.revision}`} client={client} evidence={evidence.resource} onBack={onBack} onBatches={onBatches} onChanged={evidence.refresh} /> : <div className="labs-flat-body labs-resource-page learning-workspace"><LearningError error={evidence.error} /><p role="status">{evidence.error ? "This example could not be opened." : "Loading example…"}</p><button type="button" className="training-button secondary" onClick={onBack}>Back to review</button></div>;
}

function EvidenceReview({ canManage, client, evidence, onBack, onBatches, onChanged }: { canManage: boolean; client: OpenPondLearningClient | null; evidence: TaskEvidence; onBack: () => void; onBatches?: () => void; onChanged: () => void }) {
  const definition = useLearningResource(client, "definition", evidence.submission.taskDefinition.id, evidence.submission.taskDefinition.revision);
  const grades = useLearningResources(client, "grade", { parentId: evidence.id, limit: 30 }, true);
  const decisions = useLearningResources(client, "decision", { parentId: evidence.id, limit: 1 });
  const [rating, setRating] = useState(emptyTaskRating);
  const [correctAnswer, setCorrectAnswer] = useState(false);
  const [target, setTarget] = useState("{}");
  const [gradeBudget, setGradeBudget] = useState("0");
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const queuedReceipt = useLearningResource(client, "grade", queuedId, undefined, true);
  const [trainingUse, setTrainingUse] = useState<"approved" | "rejected" | "pending">("approved");
  const [note, setNote] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useLearningMutation(client);
  const { inspection, error: inspectionError } = useLearningInspection(client, learningRef(evidence));
  const snapshot = JSON.stringify({ rating, correctAnswer, target, trainingUse, note });
  const [saved, setSaved] = useState(snapshot);
  // Keep every request stable across partial failures and retries of the same review.
  const saveAttempt = useRef<{ snapshot: string; execute: (api: OpenPondLearningClient) => Promise<unknown> } | null>(null);
  const guard = useDraftNavigation({ name: "review", dirty: snapshot !== saved, busy: mutation.busy, save: saveReview });
  const gradeMap = new Map<string, TaskGradeRun>();
  for (const entry of [...(grades.page?.items ?? []), queuedReceipt.resource]) {
    if (entry && sameLearningRef(entry.evidence, learningRef(evidence)) && entry.revision >= (gradeMap.get(entry.id)?.revision ?? 0)) gradeMap.set(entry.id, entry);
  }
  const allGrades = [...gradeMap.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const observedGrade = allGrades.find(entry => entry.target === "observed" && entry.status === "completed") ?? null;
  let proposed: Record<string, unknown> | null = null;
  try { if (correctAnswer) proposed = parseLearningObject(target); } catch { /* The editor validates before saving or grading. */ }
  const targetGrade = allGrades.find(entry => entry.target === "proposed_target" && entry.status === "completed" && equalJson(entry.output, proposed)) ?? null;
  const activeGrade = allGrades.find(entry => ["queued", "running", "cancelling"].includes(entry.status));
  const decision = decisions.page?.items[0] ?? null;
  const currentDecision = decision && sameLearningRef(decision.evidence, learningRef(evidence)) ? decision : null;
  async function saveReview() {
    const result = await mutation.run(async api => {
      if (!saveAttempt.current || saveAttempt.current.snapshot !== snapshot) {
        const value = TaskRatingSchema.parse(rating);
        const approvedTarget = correctAnswer ? parseLearningObject(target) : null;
        if (correctAnswer && trainingUse !== "approved") throw new Error("Choose Allow training to approve a corrected answer, or turn off the correction.");
        if (trainingUse === "approved" && !inspection?.taskReady) throw new Error("This task needs correction. Choose Exclude or Decide later before saving.");
        if (correctAnswer && !gradePassed(targetGrade)) throw new Error("Check the corrected answer and resolve any failed reward checks before saving.");
        const submission = { schemaVersion: "openpond.taskFeedback.v1" as const, sourceId: evidence.submission.sourceId, exampleId: evidence.submission.exampleId, attemptId: evidence.submission.attemptId, expectedEvidenceHash: evidence.contentHash, occurredAt: new Date().toISOString(), note };
        const ratingSubmission = { ...submission, kind: "outcome" as const, value, idempotencyKey: learningOperationId() };
        const targetSubmission = approvedTarget ? { ...submission, kind: "target_correction" as const, value: approvedTarget, idempotencyKey: learningOperationId() } : null;
        const command = { action: "review" as const, operationId: learningOperationId(), evidence: learningRef(evidence), expectedRevision: decision?.revision ?? 0, disposition: trainingUse, targetApproval: approvedTarget ? "approved" as const : trainingUse === "rejected" ? "rejected" as const : "not_required" as const, approvedTarget, observedGradeId: observedGrade?.id ?? null, targetGradeId: approvedTarget ? targetGrade?.id ?? null : null, note };
        const ratingResolutionId = learningOperationId();
        const targetResolutionId = learningOperationId();
        let retainedFeedback: ReturnType<typeof TaskFeedbackSchema.parse> | null = null;
        let retainedCorrection: ReturnType<typeof TaskFeedbackSchema.parse> | null = null;
        let retainedDecision: ReturnType<typeof TaskAdmissionDecisionSchema.parse> | null = null;
        saveAttempt.current = { snapshot, execute: async api => {
          const feedback = retainedFeedback ??= TaskFeedbackSchema.parse((await api.submitFeedback(ratingSubmission)).resources[0]);
          const correction = targetSubmission ? retainedCorrection ??= TaskFeedbackSchema.parse((await api.submitFeedback(targetSubmission)).resources[0]) : null;
          const review = retainedDecision ??= TaskAdmissionDecisionSchema.parse((await api.command(command)).resources[0]);
          if (review.taskAdmissibility !== "pending") {
            for (const [entry, operationId] of [[feedback, ratingResolutionId], [correction, targetResolutionId]] as const) {
              if (entry) await api.command({ action: "resolve_feedback", operationId, feedbackId: entry.id, expectedRevision: entry.revision, disposition: "applied", decision: learningRef(review), note });
            }
          }
          return review;
        } };
      }
      return saveAttempt.current.execute(api);
    });
    if (result) { setSaved(snapshot); setNotice(trainingUse === "pending" ? "Rating saved. This example stays in the inbox until training use is decided." : "Review saved."); saveAttempt.current = null; }
    return Boolean(result);
  }
  async function grade(output: "observed" | "proposed_target") {
    const result = await mutation.run(async api => TaskGradeRunSchema.parse((await api.command({ action: "queue_grade", operationId: learningOperationId(), evidence: learningRef(evidence), target: output, proposedTarget: output === "observed" ? null : parseLearningObject(target), timeoutMs: 30_000, maximumSpendUsd: Number(gradeBudget) })).resources[0]));
    if (result) { setQueuedId(result.id); }
  }
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={definition.resource?.name ?? "Review response"} actions={<><button type="button" className="training-button secondary" onClick={onBack}>Back to labeling</button>{canManage ? <button type="button" className="training-button" disabled={mutation.busy || decisions.loading} onClick={() => { void saveReview(); }}>{mutation.busy ? "Saving…" : "Save review"}</button> : null}</>} />
    <LearningError error={mutation.error ?? inspectionError ?? definition.error ?? decisions.error ?? grades.error ?? queuedReceipt.error} />{notice ? <p role="status">{notice}</p> : null}
    <div className="learning-review-layout">
      <div className="learning-review-content">
        <section className="learning-review-surface"><LearningValue label="Request" value={evidence.submission.input} /></section>
        <section className="learning-review-surface"><LearningValue label="Response" value={evidence.submission.observedOutput} /></section>
        <details className="learning-review-surface"><summary>Expected answer and task context</summary><LearningValue label="Expected answer (evaluator only)" value={evidence.submission.expected} /><LearningValue label="Evaluator context" value={evidence.submission.evaluatorContext} />{definition.resource ? <LearningValue label="Instructions" value={definition.resource.instructions} /> : null}</details>
      </div>
      <aside className="learning-review-sidebar">
        <section className="learning-review-surface"><h2>Automated reward</h2><p>{observedGrade ? gradeSummary(observedGrade) : activeGrade ? "Checking response…" : "No completed check for this response."}</p>{observedGrade?.composition ? <RewardCompositionDetails client={client} composition={observedGrade.composition} /> : null}
          <details><summary>Run a check</summary><label>Maximum cost (USD)<input type="number" min={0} max={1000} step="0.01" disabled={!canManage || mutation.busy} value={gradeBudget} onChange={event => setGradeBudget(event.target.value)} /><small>Per check. $0 permits checks that do not call a model.</small></label><button type="button" className="training-button secondary" disabled={!canManage || mutation.busy || !inspection?.taskReady || !evidence.submission.observedOutput || Boolean(activeGrade)} onClick={() => { void grade("observed"); }}>Check response</button></details>
        </section>
        <section className="learning-review-surface"><fieldset disabled={!canManage || mutation.busy}><TaskRatingFields value={rating} onChange={setRating} />
          <details><summary>Corrected answer</summary><label className="learning-inline-choice"><input type="checkbox" checked={correctAnswer} onChange={event => setCorrectAnswer(event.target.checked)} />Provide an answer for supervised training</label>{correctAnswer ? <><LearningJsonField label="Corrected answer" hint="Match the task's output fields. The answer must pass its reward checks before approval." value={target} onChange={setTarget} /><button type="button" className="training-button secondary" disabled={!inspection?.taskReady || Boolean(activeGrade)} onClick={() => { void grade("proposed_target"); }}>Check corrected answer</button><p>{targetGrade ? gradeSummary(targetGrade) : "Check this answer before saving."}</p></> : null}</details>
          <details><summary>Training use · {trainingUse === "approved" ? "Allowed" : trainingUse === "rejected" ? "Excluded" : "Undecided"}</summary><p>A low response rating can still be useful for training. Exclude an example when the task itself should not be used.</p>{(["approved", "rejected", "pending"] as const).map(value => <label className="learning-inline-choice" key={value}><input type="radio" name="training-use" value={value} checked={trainingUse === value} onChange={() => setTrainingUse(value)} />{value === "approved" ? "Allow training" : value === "rejected" ? "Exclude this task" : "Decide later"}</label>)}{inspection?.issues.length ? <ul>{inspection.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}</details>
          <label>Review note<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
        </fieldset></section>
      </aside>
    </div>
    <details className="learning-review-surface" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Review history and task corrections</summary>{historyOpen ? <><LearningValue label="Latest decision" value={currentDecision ? { trainingUse: currentDecision.taskAdmissibility, automatedResult: currentDecision.observedQuality, correctedAnswer: currentDecision.targetApproval, note: currentDecision.note } : "No review saved."} /><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Checked answer</th><th>Status</th><th>Result</th></tr></thead><tbody>{allGrades.map(entry => <tr key={entry.id}><td>{entry.target === "observed" ? "Response" : "Corrected answer"}</td><td>{entry.status}</td><td>{gradeSummary(entry)}</td></tr>)}</tbody></table></div>{canManage ? <LearningFeedback client={client} evidence={evidence} decision={currentDecision} onChanged={() => { void guard.requestLeave(onChanged); }} onTarget={value => { setTarget(JSON.stringify(value, null, 2)); setCorrectAnswer(true); }} /> : null}<LearningValue label="Provenance" value={{ source: evidence.source, ...evidence.submission.provenance, supersedes: evidence.supersedes }} />{canManage && currentDecision?.taskAdmissibility === "approved" && onBatches ? <button type="button" className="training-button secondary" onClick={onBatches}>Approved batches</button> : null}</> : null}</details>
    {guard.dialog}
  </div>;
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key]));
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
