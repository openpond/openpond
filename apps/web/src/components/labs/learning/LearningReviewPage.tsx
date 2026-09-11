import type { OpenPondLearningClient } from "openpond-sdk/learning";
import { useRef, useState } from "react";
import { learningRef, sameLearningRef, TaskAdmissionDecisionSchema, TaskGradeRunSchema, TaskRatingSchema, type TaskEvidence, type TaskGradeRun } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningActions, LearningError, LearningPager, LearningValue, parseLearningObject } from "./LearningFields";
import { learningOperationId, useLearningInspection, useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";
import { LearningFeedback } from "./LearningFeedback";
import { RewardCompositionDetails } from "./RewardCompositionView";
import { emptyTaskRating, TaskRatingFields } from "./TaskRatingFields";
import { useDraftNavigation } from "../useDraftNavigation";
import { createEvidenceReviewSave, reviewDisposition } from "./saveEvidenceReview";
import { LearningEditorDialog } from "./LearningEditorDialog";
import { ReviewCorrectionEditor, ReviewEvidenceView } from "./ReviewEvidenceView";

export function LearningReviewPage({ canManage = true, client, selectedId, after, sourceId = null, onClearSource, onSelect, onPage, onBatches, onReward }: { canManage?: boolean; client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; sourceId?: string | null; onClearSource?: () => void; onSelect: (id: string | null) => void; onPage: (cursor: string | null) => void; onBatches?: () => void; onReward?: (id: string) => void }) {
  const [reviewState, setReviewState] = useState<"inbox" | "reviewed">("inbox");
  const [search, setSearch] = useState("");
  const [fullPage, setFullPage] = useState(false);
  const evidence = useLearningResources(client, "evidence", { reviewState, limit: 30, ...(sourceId ? { parentId: sourceId } : {}), ...(after ? { afterId: after } : {}) });
  const source = useLearningResource(client, "source", sourceId);
  const items = evidence.page?.items.filter(entry => !search || requestSummary(entry.submission.input).toLowerCase().includes(search.toLowerCase())) ?? [];
  const close = () => { evidence.refresh(); onSelect(null); setFullPage(false); };
  const review = selectedId ? <EvidenceLoader canManage={canManage} key={selectedId} client={client} id={selectedId} sourceId={sourceId} onBack={close} onBatches={onBatches} onReward={onReward} onFullPage={() => setFullPage(value => !value)} fullPage={fullPage} onNext={() => {
    const index = items.findIndex(entry => entry.id === selectedId);
    const next = items.slice(index + 1).find(entry => entry.id !== selectedId);
    evidence.refresh();
    if (next) onSelect(next.id); else close();
  }} /> : null;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title="Labeling" description={sourceId ? `Review tasks from ${source.resource?.name ?? sourceId}. Task validity and target approval remain separate decisions.` : "Label observed responses, propose corrections, and approve tasks independently. Examples are shared across Models in this workspace."} actions={<>{onBatches ? <button type="button" className="training-button secondary" onClick={onBatches}>Approved batches</button> : null}{sourceId && onClearSource ? <button type="button" className="training-button secondary" onClick={onClearSource}>All workspace examples</button> : null}</>} />
    <div hidden={Boolean(selectedId && fullPage)}>
    <div className="learning-review-filters"><label>Review status<select aria-label="Review status" value={reviewState} onChange={event => { setReviewState(event.target.value as "inbox" | "reviewed"); onPage(null); }}><option value="inbox">Needs review</option><option value="reviewed">Reviewed</option></select></label><label>Search this page<input type="search" placeholder="Find a request…" value={search} onChange={event => setSearch(event.target.value)} /></label><button type="button" className="training-button" disabled={evidence.loading || !items.length} onClick={() => { const next = items[0]; if (next) onSelect(next.id); }}>Review next</button></div>
    <LearningError error={evidence.error ?? source.error} /><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Conversation / request</th><th>Source</th><th>Received</th><th>Review status</th></tr></thead><tbody>{items.map(entry => <EvidenceRow key={entry.id} client={client} evidence={entry} reviewState={reviewState} onSelect={onSelect} />)}</tbody></table></div>
    {evidence.loading ? <p role="status">Loading examples…</p> : !items.length ? <p>{search ? "No requests match on this page." : reviewState === "inbox" ? "You're caught up. New retained attempts will appear here for review." : "No reviewed examples in this scope yet."}</p> : null}<LearningPager after={after} next={evidence.page?.nextCursor} onPage={onPage} />
    </div>
    {review ? <LearningEditorDialog title="Review attempt" wide fullPage={fullPage} onClose={close}>{review}</LearningEditorDialog> : null}
  </div>;
}

function EvidenceRow({ client, evidence, reviewState, onSelect }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; reviewState: "inbox" | "reviewed"; onSelect: (id: string) => void }) {
  const source = useLearningResource(client, "source", evidence.source.id, evidence.source.revision);
  return <tr><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(evidence.id)}><strong>{requestSummary(evidence.submission.input) || "Open request"}</strong></button></td><td>{source.resource?.name ?? "Source"}<LearningError error={source.error} /></td><td><time dateTime={evidence.receivedAt}>{new Date(evidence.receivedAt).toLocaleDateString()}</time></td><td>{reviewState === "inbox" ? "Needs review" : "Reviewed"}</td></tr>;
}
function requestSummary(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 180);
  if (!value || typeof value !== "object") return "";
  if ("request" in value && typeof value.request === "string") return value.request.slice(0, 180);
  return Object.values(value).map(requestSummary).filter(Boolean).join(" · ").slice(0, 180);
}

interface ReviewNavigation { onReward?: (id: string) => void; onNext: () => void; onFullPage: () => void; fullPage: boolean }
function EvidenceLoader({ canManage, client, id, sourceId, onBack, onBatches, ...navigation }: { canManage: boolean; client: OpenPondLearningClient | null; id: string; sourceId: string | null; onBack: () => void; onBatches?: () => void } & ReviewNavigation) {
  const evidence = useLearningResource(client, "evidence", id);
  if (evidence.resource && sourceId && evidence.resource.source.id !== sourceId) return <div className="learning-workspace"><LearningError error="This example does not belong to the selected source." /><button type="button" className="training-button secondary" onClick={onBack}>Back to review</button></div>;
  return evidence.resource ? <EvidenceReview {...navigation} canManage={canManage} key={`${id}:${evidence.resource.revision}`} client={client} evidence={evidence.resource} onBack={onBack} onBatches={onBatches} onChanged={evidence.refresh} /> : <div className="labs-flat-body labs-resource-page learning-workspace"><LearningError error={evidence.error} /><p role="status">{evidence.error ? "This example could not be opened." : "Loading example…"}</p><button type="button" className="training-button secondary" onClick={onBack}>Back to review</button></div>;
}

function EvidenceReview({ canManage, client, evidence, onBack, onBatches, onChanged, onNext, onFullPage, fullPage, onReward }: { canManage: boolean; client: OpenPondLearningClient | null; evidence: TaskEvidence; onBack: () => void; onBatches?: () => void; onChanged: () => void } & ReviewNavigation) {
  const definition = useLearningResource(client, "definition", evidence.submission.taskDefinition.id, evidence.submission.taskDefinition.revision);
  const grades = useLearningResources(client, "grade", { parentId: evidence.id, limit: 30 }, true);
  const decisions = useLearningResources(client, "decision", { parentId: evidence.id, limit: 1 });
  const [rating, setRating] = useState(() => ({ ...emptyTaskRating(), score: Number.NaN }));
  const [cannotAssess, setCannotAssess] = useState(false);
  const [correctAnswer, setCorrectAnswer] = useState(false);
  const [target, setTarget] = useState(() => JSON.stringify(evidence.submission.observedOutput ?? evidence.submission.expected ?? {}, null, 2));
  const [gradeBudget, setGradeBudget] = useState("0");
  const [queuedId, setQueuedId] = useState<string | null>(null);
  const queuedReceipt = useLearningResource(client, "grade", queuedId, undefined, true);
  const [trainingUse, setTrainingUse] = useState<"approved" | "rejected" | "pending">("approved");
  const [note, setNote] = useState("");
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
    if (result) { setSaved(snapshot); const review = TaskAdmissionDecisionSchema.parse(result); setNotice(review.taskAdmissibility === "pending" ? "Feedback saved. Learning use is pending; this attempt stays in Needs review." : "Review saved."); saveAttempt.current = null; }
    return Boolean(result);
  }
  async function grade(output: "observed" | "proposed_target") {
    const result = await mutation.run(async api => TaskGradeRunSchema.parse((await api.command({ action: "queue_grade", operationId: learningOperationId(), evidence: learningRef(evidence), target: output, proposedTarget: output === "observed" ? null : parseLearningObject(target), timeoutMs: 30_000, maximumSpendUsd: Number(gradeBudget) })).resources[0]));
    if (result) { setQueuedId(result.id); }
  }
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <header className="learning-review-heading"><h2>{definition.resource?.name ?? "Review response"}</h2><LearningActions><button type="button" className="training-button secondary" onClick={() => { void guard.requestLeave(onBack); }}>Back to labeling</button><button type="button" className="training-button secondary" onClick={onFullPage}>{fullPage ? "Open in dialog" : "Full page"}</button></LearningActions></header>
    <LearningError error={mutation.error ?? inspectionError ?? definition.error ?? decisions.error ?? grades.error ?? queuedReceipt.error} />{notice ? <p role="status">{notice}</p> : null}
    <div className="learning-review-layout">
      <div className="learning-review-content">
        <ReviewEvidenceView evidence={evidence} />
        <details className="learning-review-surface"><summary>Expected answer and task context</summary><LearningValue label="Expected answer (evaluator only)" value={evidence.submission.expected} /><LearningValue label="Evaluator context" value={evidence.submission.evaluatorContext} />{definition.resource ? <LearningValue label="Instructions" value={definition.resource.instructions} /> : null}</details>
      </div>
      <aside className="learning-review-sidebar">
        <section className="learning-review-surface"><h2>Automated reward</h2><p>{observedGrade ? gradeSummary(observedGrade) : activeGrade ? "Checking response…" : "No completed check for this response."}</p>{observedGrade?.composition ? <RewardCompositionDetails client={client} composition={observedGrade.composition} /> : null}
          {definition.resource && onReward ? <button type="button" className="training-button secondary" onClick={() => { void guard.requestLeave(() => onReward(definition.resource!.rewardBinding.id)); }}>Review grader</button> : null}
          <details><summary>Run a check</summary><label>Maximum cost (USD)<input type="number" min={0} max={1000} step="0.01" disabled={!canManage || mutation.busy} value={gradeBudget} onChange={event => setGradeBudget(event.target.value)} /><small>Per check. $0 permits checks that do not call a model.</small></label><button type="button" className="training-button secondary" disabled={!canManage || mutation.busy || !inspection?.taskReady || !evidence.submission.observedOutput || Boolean(activeGrade)} onClick={() => { void grade("observed"); }}>Check response</button></details>
        </section>
        <section className="learning-review-surface"><fieldset disabled={!canManage || mutation.busy}><h2>Feedback and corrections</h2><label className="learning-inline-choice"><input type="checkbox" checked={cannotAssess} onChange={event => setCannotAssess(event.target.checked)} />Cannot assess this response</label>{!cannotAssess ? <TaskRatingFields value={rating} onChange={setRating} /> : null}
          <label className="learning-inline-choice"><input type="checkbox" checked={correctAnswer} onChange={event => setCorrectAnswer(event.target.checked)} />Add a corrected answer</label>{correctAnswer ? <><ReviewCorrectionEditor value={target} onChange={setTarget} /><button type="button" className="training-button secondary" disabled={!inspection?.taskReady || Boolean(activeGrade)} onClick={() => { void grade("proposed_target"); }}>Check corrected answer</button><p>{targetGrade ? gradeSummary(targetGrade) : "No completed check for this correction."}</p>{!gradePassed(targetGrade) ? <p>Your correction will be saved. Use for supervised training stays pending until its reward checks pass.</p> : null}</> : null}
          <details><summary>Training use · {trainingUse === "approved" ? "Allowed" : trainingUse === "rejected" ? "Excluded" : "Undecided"}</summary><p>A low response rating can still be useful for training. Exclude an example when the task itself should not be used.</p>{(["approved", "rejected", "pending"] as const).map(value => <label className="learning-inline-choice" key={value}><input type="radio" name="training-use" value={value} checked={trainingUse === value} onChange={() => setTrainingUse(value)} />{value === "approved" ? "Allow training" : value === "rejected" ? "Exclude this task" : "Decide later"}</label>)}{inspection?.issues.length ? <ul>{inspection.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}</details>
          <label>Review note<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
        </fieldset>{canManage ? <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy || decisions.loading} onClick={() => { void saveReview(); }}>Save</button><button type="button" className="training-button" disabled={mutation.busy || decisions.loading} onClick={async () => { if (await saveReview()) { guard.allowNextNavigation(); await guard.requestLeave(onNext); } }}>{mutation.busy ? "Saving…" : "Save and next"}</button></LearningActions> : null}</section>
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
