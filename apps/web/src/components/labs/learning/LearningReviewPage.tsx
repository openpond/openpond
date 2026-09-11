import type { OpenPondLearningClient } from "openpond-sdk/learning";
import { ModelsPageSearch } from "../ModelsPageSearch";
import { useQuery } from "@tanstack/react-query";
import { learningQueryScope } from "../../../lib/query-scope";
import { useRef, useState } from "react";
import { learningRef, sameLearningRef, TaskAdmissionDecisionSchema, TaskGradeRunSchema, TaskRatingSchema, type TaskEvidence, type TaskGradeRun } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningActions, LearningError, LearningPager, LearningValue, parseLearningObject } from "./LearningFields";
import { learningOperationId, useLearningInspection, useLearningMutation, useLearningResource, useLearningResources, useLearningCatalog } from "./useLearningResources";
import { LearningFeedback } from "./LearningFeedback";
import { RewardCompositionDetails } from "./RewardCompositionView";
import { TaskRatingFields } from "./TaskRatingFields";
import { useDraftNavigation } from "../useDraftNavigation";
import { createEvidenceReviewSave, reviewDisposition } from "./saveEvidenceReview";
import { evidenceReviewState } from "./evidence-review-state";
import { ReviewCorrectionEditor, ReviewEvidenceView } from "./ReviewEvidenceView";

export function LearningReviewPage({ canManage = true, client, selectedId, after, sourceId = null, onClearSource, onSelect, onPage, onBatches, onReward }: { canManage?: boolean; client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; sourceId?: string | null; onClearSource?: () => void; onSelect: (id: string | null) => void; onPage: (cursor: string | null) => void; onBatches?: () => void; onReward?: (id: string) => void }) {
  const [reviewState, setReviewState] = useState<"all" | "inbox" | "reviewed">("all");
  const [search, setSearch] = useState("");
  const evidence = useLearningResources(client, "evidence", { limit: 30, ...(sourceId ? { parentId: sourceId } : {}), ...(after ? { afterId: after } : {}) });
  const decisions = useReviewDecisions(client, evidence.page?.items ?? [], Boolean(sourceId));
  const items = evidence.page?.items.filter(entry => (!search || requestSummary(entry.submission.input).toLowerCase().includes(search.toLowerCase())) && (reviewState === "all" || (isEvidenceReviewed(entry, decisions.items) ? "reviewed" : "inbox") === reviewState)) ?? [];
  const close = () => { evidence.refresh(); onSelect(null); };
  if (selectedId) return <EvidenceLoader canManage={canManage} key={selectedId} client={client} id={selectedId} sourceId={sourceId} onBack={close} onBatches={onBatches} onReward={onReward} />;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title="Tasks" actions={<><ModelsPageSearch label="Search tasks" value={search} onSearch={setSearch} />{sourceId && onClearSource ? <button type="button" className="training-button secondary" onClick={onClearSource}>All tasks</button> : null}</>} />
    <div className="learning-review-filters"><label>Review status<select aria-label="Review status" value={reviewState} onChange={event => { setReviewState(event.target.value as typeof reviewState); onPage(null); }}><option value="all">All statuses</option><option value="inbox">Needs review</option><option value="reviewed">Reviewed</option></select></label></div>
    <LearningError error={evidence.error ?? decisions.error} /><div className="training-table-wrap"><table className="models-data-table"><thead><tr><th>Task</th><th>Source</th><th>Split</th><th>Received</th><th>Status</th></tr></thead><tbody>{items.map(entry => <EvidenceRow key={entry.id} client={client} evidence={entry} reviewed={isEvidenceReviewed(entry, decisions.items)} onSelect={onSelect} />)}</tbody></table></div>
    {evidence.loading ? <p role="status">Loading tasks…</p> : !items.length ? <p>No attempts match this view.</p> : null}<LearningPager after={after} next={evidence.page?.nextCursor} onPage={onPage} />
  </div>;
}

export function isEvidenceReviewed(evidence: TaskEvidence, decisions: import("openpond-sdk/learning").TaskAdmissionDecision[]) {
  return decisions.some(decision => sameLearningRef(decision.evidence, learningRef(evidence)) && decision.actor.kind === "human");
}

export function EvidenceRow({ client, evidence, reviewed, onSelect, inventory = false }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; reviewed: boolean; onSelect: (id: string) => void; inventory?: boolean }) {
  const source = useLearningResource(client, "source", evidence.source.id, evidence.source.revision);
  return <tr><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(evidence.id)}><strong>{requestSummary(evidence.submission.input) || "Open request"}</strong><small>Recorded attempt</small></button></td><td>{source.resource?.name ?? "Source"}<LearningError error={source.error} /></td><td>{evidence.submission.split === "train" ? "Training" : evidence.submission.split === "frozen_eval" ? "Held-out evaluation" : evidence.submission.split.replaceAll("_", " ")}</td><td>{inventory ? "See review" : <time dateTime={evidence.receivedAt}>{new Date(evidence.receivedAt).toLocaleDateString()}</time>}</td><td><button type="button" className={`training-button ${reviewed ? "reviewed-status" : "review-status"}`} onClick={() => onSelect(evidence.id)}>{reviewed ? "Reviewed" : "Review"}</button></td></tr>;
}
export function requestSummary(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 180);
  if (!value || typeof value !== "object") return "";
  if ("request" in value && typeof value.request === "string") return value.request.slice(0, 180);
  return Object.values(value).map(requestSummary).filter(Boolean).join(" · ").slice(0, 180);
}

export function EvidenceLoader({ canManage, client, id, sourceId, onBack, onBatches, onReward }: { canManage: boolean; client: OpenPondLearningClient | null; id: string; sourceId: string | null; onBack: () => void; onBatches?: () => void; onReward?: (id: string) => void }) {
  const evidence = useLearningResource(client, "evidence", id);
  const decisions = useLearningResources(client, "decision", { parentId: id, limit: 1 });
  const feedback = useLearningCatalog(client, "feedback", { parentId: id });
  if (decisions.loading || feedback.loading) return <p role="status">Loading saved review…</p>;
  if (decisions.error || feedback.error) return <><LearningError error={decisions.error ?? feedback.error} /><button type="button" className="training-button secondary" onClick={onBack}>Back to tasks</button></>;
  if (evidence.resource && sourceId && evidence.resource.source.id !== sourceId) return <div className="learning-workspace"><LearningError error="This example does not belong to the selected source." /><button type="button" className="training-button secondary" onClick={onBack}>Back to review</button></div>;
  return evidence.resource ? <EvidenceReview initial={evidenceReviewState(evidence.resource, decisions.page?.items ?? [], feedback.items)} canManage={canManage} key={`${id}:${evidence.resource.revision}`} client={client} evidence={evidence.resource} onBack={onBack} onBatches={onBatches} onReward={onReward} onChanged={evidence.refresh} /> : <div className="labs-flat-body labs-resource-page learning-workspace"><LearningError error={evidence.error} /><p role="status">{evidence.error ? "This example could not be opened." : "Loading example…"}</p><button type="button" className="training-button secondary" onClick={onBack}>Back to review</button></div>;
}

function EvidenceReview({ canManage, client, evidence, onBack, onBatches, onChanged, initial, onReward }: { canManage: boolean; client: OpenPondLearningClient | null; evidence: TaskEvidence; onBack: () => void; onBatches?: () => void; onChanged: () => void; onReward?: (id: string) => void; initial: ReturnType<typeof evidenceReviewState> }) {
  const definition = useLearningResource(client, "definition", evidence.submission.taskDefinition.id, evidence.submission.taskDefinition.revision);
  const grades = useLearningResources(client, "grade", { parentId: evidence.id, limit: 30 }, true);
  const decisions = useLearningResources(client, "decision", { parentId: evidence.id, limit: 1 });
  const [rating, setRating] = useState(initial.rating);
  const [cannotAssess, setCannotAssess] = useState(initial.cannotAssess);
  const [correctAnswer, setCorrectAnswer] = useState(initial.correctAnswer);
  const [target, setTarget] = useState(initial.target);
  const [gradeBudget, setGradeBudget] = useState("0");
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const queuedReceipt = useLearningResource(client, "grade", queuedId, undefined, true);
  const [trainingUse, setTrainingUse] = useState<"approved" | "rejected" | "pending">(initial.trainingUse);
  const [note, setNote] = useState(initial.note);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useLearningMutation(client);
  const { inspection, error: inspectionError } = useLearningInspection(client, learningRef(evidence));
  const snapshot = JSON.stringify({ rating, cannotAssess, correctAnswer, target, trainingUse, note });
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
        if (cannotAssess && !note.trim()) throw new Error("Add a note explaining why this response cannot be assessed.");
        if (!cannotAssess && !Number.isFinite(rating.score)) throw new Error("Choose a score before saving your review.");
        const value = cannotAssess ? { assessment: "cannot_assess", explanation: note } : TaskRatingSchema.parse(rating);
        const proposedTarget = correctAnswer ? parseLearningObject(target) : null;
        const disposition = reviewDisposition({ selected: trainingUse, cannotAssess, taskReady: Boolean(inspection?.taskReady), hasCorrection: correctAnswer, correctionPassed: gradePassed(targetGrade) });
        const approvedTarget = proposedTarget && disposition === "approved" ? proposedTarget : null;
        const submission = { schemaVersion: "openpond.taskFeedback.v1" as const, sourceId: evidence.submission.sourceId, exampleId: evidence.submission.exampleId, attemptId: evidence.submission.attemptId, expectedEvidenceHash: evidence.contentHash, occurredAt: new Date().toISOString(), note };
        const ratingSubmission = { ...submission, kind: "outcome" as const, value, idempotencyKey: learningOperationId() };
        const targetSubmission = proposedTarget ? { ...submission, kind: "target_correction" as const, value: proposedTarget, idempotencyKey: learningOperationId() } : null;
        const command = { action: "review" as const, operationId: learningOperationId(), evidence: learningRef(evidence), expectedRevision: decision?.revision ?? 0, disposition, targetApproval: approvedTarget ? "approved" as const : correctAnswer ? "pending" as const : trainingUse === "rejected" ? "rejected" as const : "not_required" as const, approvedTarget, observedGradeId: observedGrade?.id ?? null, targetGradeId: correctAnswer ? targetGrade?.id ?? null : null, note };
        saveAttempt.current = { snapshot, execute: createEvidenceReviewSave({ feedback: ratingSubmission, correction: targetSubmission, review: command, feedbackResolutionId: learningOperationId(), correctionResolutionId: learningOperationId() }) };
      }
      return saveAttempt.current.execute(api);
    });
    if (result) { setSaved(snapshot); const review = TaskAdmissionDecisionSchema.parse(result); setNotice(review.taskAdmissibility === "pending" ? "Review saved. Training eligibility is pending." : "Review saved."); saveAttempt.current = null; }
    return Boolean(result);
  }
  async function grade(output: "observed" | "proposed_target") {
    const result = await mutation.run(async api => TaskGradeRunSchema.parse((await api.command({ action: "queue_grade", operationId: learningOperationId(), evidence: learningRef(evidence), target: output, proposedTarget: output === "observed" ? null : parseLearningObject(target), timeoutMs: 30_000, maximumSpendUsd: Number(gradeBudget) })).resources[0]));
    if (result) { setQueuedId(result.id); }
  }
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={definition.resource?.name ?? "Review response"} actions={<button type="button" className="training-button secondary" onClick={() => { void guard.requestLeave(onBack); }}>Back to tasks</button>} />
    <LearningError error={mutation.error ?? inspectionError ?? definition.error ?? decisions.error ?? grades.error ?? queuedReceipt.error} />{notice ? <p role="status">{notice}</p> : null}
    <div className="learning-review-layout">
      <div className="learning-review-content">
        <ReviewEvidenceView evidence={evidence} />
        <details className="learning-review-surface"><summary>Expected answer and task context</summary><LearningValue label="Expected answer (evaluator only)" value={evidence.submission.expected} /><LearningValue label="Evaluator context" value={evidence.submission.evaluatorContext} />{definition.resource ? <LearningValue label="Instructions" value={definition.resource.instructions} /> : null}</details>
      </div>
      <aside className="learning-review-sidebar">
        <section className="learning-review-surface"><h2>Grader result</h2><p>{observedGrade ? gradeSummary(observedGrade) : activeGrade ? "Checking response…" : "No completed check for this response."}</p>{observedGrade?.composition ? <RewardCompositionDetails client={client} composition={observedGrade.composition} /> : null}
          {definition.resource && onReward ? <button type="button" className="training-button secondary" onClick={() => { void guard.requestLeave(() => onReward(definition.resource!.rewardBinding.id)); }}>Review grader</button> : null}
          <details><summary>Run a check</summary><label>Maximum cost (USD)<input type="number" min={0} max={1000} step="0.01" disabled={!canManage || mutation.busy} value={gradeBudget} onChange={event => setGradeBudget(event.target.value)} /><small>Per check. $0 permits checks that do not call a model.</small></label><button type="button" className="training-button secondary" disabled={!canManage || mutation.busy || !inspection?.taskReady || !evidence.submission.observedOutput || Boolean(activeGrade)} onClick={() => { void grade("observed"); }}>Check response</button></details>
        </section>
        <section className="learning-review-surface"><fieldset disabled={!canManage || mutation.busy}><h2>Feedback and corrections</h2><label className="learning-inline-choice"><input type="checkbox" checked={cannotAssess} onChange={event => setCannotAssess(event.target.checked)} />Cannot assess this response</label>{!cannotAssess ? <TaskRatingFields value={rating} onChange={setRating} /> : null}
          <label className="learning-inline-choice"><input type="checkbox" checked={correctAnswer} onChange={event => setCorrectAnswer(event.target.checked)} />Add a corrected answer</label>{correctAnswer ? <><ReviewCorrectionEditor value={target} onChange={setTarget} /><button type="button" className="training-button secondary" disabled={!inspection?.taskReady || Boolean(activeGrade)} onClick={() => { void grade("proposed_target"); }}>Check corrected answer</button><p>{targetGrade ? gradeSummary(targetGrade) : "No completed check for this correction."}</p>{!gradePassed(targetGrade) ? <p>Your correction will be saved. Use for supervised training stays pending until its reward checks pass.</p> : null}</> : null}
          <details><summary>Training use · {trainingUse === "approved" ? "Allowed" : trainingUse === "rejected" ? "Excluded" : "Undecided"}</summary><p>A low response rating can still be useful for training. Exclude an example when the task itself should not be used.</p>{(["approved", "rejected", "pending"] as const).map(value => <label className="learning-inline-choice" key={value}><input type="radio" name="training-use" value={value} checked={trainingUse === value} onChange={() => setTrainingUse(value)} />{value === "approved" ? "Allow training" : value === "rejected" ? "Exclude this task" : "Decide later"}</label>)}{inspection?.issues.length ? <ul>{inspection.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}</details>
          <label>Review note<textarea aria-label="Review note" value={note} onChange={event => setNote(event.target.value)} /></label>
        </fieldset>{canManage ? <LearningActions><button type="button" className="training-button" disabled={mutation.busy || decisions.loading} onClick={() => { void saveReview(); }}>{mutation.busy ? "Saving…" : "Save review"}</button></LearningActions> : null}</section>
      </aside>
    </div>
    <details className="learning-review-surface" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Review history and task corrections</summary>{historyOpen ? <><LearningValue label="Latest decision" value={currentDecision ? { trainingUse: currentDecision.taskAdmissibility, automatedResult: currentDecision.observedQuality, correctedAnswer: currentDecision.targetApproval, note: currentDecision.note } : "No review saved."} /><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Checked answer</th><th>Status</th><th>Result</th></tr></thead><tbody>{allGrades.map(entry => <tr key={entry.id}><td>{entry.target === "observed" ? "Response" : "Corrected answer"}</td><td>{entry.status}</td><td>{gradeSummary(entry)}</td></tr>)}</tbody></table></div>{canManage ? <LearningFeedback historyOnly client={client} evidence={evidence} decision={currentDecision} onChanged={() => { void guard.requestLeave(onChanged); }} onTarget={value => { setTarget(JSON.stringify(value, null, 2)); setCorrectAnswer(true); }} /> : null}<LearningValue label="Provenance" value={{ source: evidence.source, ...evidence.submission.provenance, supersedes: evidence.supersedes }} />{canManage && currentDecision?.taskAdmissibility === "approved" && onBatches ? <button type="button" className="training-button secondary" onClick={onBatches}>Approved batches</button> : null}</> : null}</details>
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

function useReviewDecisions(client: OpenPondLearningClient | null, evidence: TaskEvidence[], scoped: boolean) {
  const catalog = useLearningCatalog(scoped ? null : client, "decision");
  const ids = evidence.map(item => item.id).sort();
  const query = useQuery({ queryKey: [...learningQueryScope(client), "review-decisions", ids], enabled: Boolean(client && scoped), queryFn: async ({ signal }) => {
    const pages = await Promise.all(ids.map(parentId => client!.list("decision", { parentId, limit: 100 }, { signal })));
    return pages.flatMap(page => page.items);
  } });
  return scoped ? { items: query.data ?? [], loading: query.isLoading, error: query.error?.message ?? null } : catalog;
}
