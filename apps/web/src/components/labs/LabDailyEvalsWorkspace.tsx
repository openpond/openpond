import { useEffect, useMemo, useState } from "react";
import type { ContinualLearningDailyBatch, ModelComparisonSeries, TaskDataRecord, Taskset, TrainingStateResponse } from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";

type IntakeTask = ContinualLearningDailyBatch["tasks"][number];
type CapturedAttempt = NonNullable<IntakeTask["observedAttempt"]>;
type InboxItem = { batch: ContinualLearningDailyBatch; task: IntakeTask; source: TaskDataRecord | null; taskset: Taskset | null };
type ResponseRecord = { key: string; label: string; attempt: CapturedAttempt };

export function LabDailyEvalsWorkspace({ onOpenSeries, onToast, series, state, training }: {
  onOpenSeries: (seriesId: string) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  series: ModelComparisonSeries;
  state: TrainingStateResponse;
  training: ReturnType<typeof useTraining>;
}) {
  const batches = useMemo(
    () => state.continualLearningDailyBatches.filter((batch) => batch.seriesId === series.id).sort((a, b) => a.availableAt.localeCompare(b.availableAt)),
    [series.id, state.continualLearningDailyBatches],
  );
  const items = useMemo(() => batches.flatMap((batch) => {
    const taskset = exactTaskset(state, batch.sourceTaskset);
    return batch.tasks.map((task) => ({ batch, task, taskset, source: taskset?.tasks.find((candidate) => candidate.id === task.taskId) ?? null }));
  }), [batches, state.modelTasksets, state.tasksets]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<InboxItem | null>(null);
  const [taskDraft, setTaskDraft] = useState<IntakeTask | null>(null);
  const [evidence, setEvidence] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!review) return;
    const current = items.find((item) => item.batch.id === review.batch.id && item.task.taskId === review.task.taskId) ?? null;
    if (!current) { setReview(null); setTaskDraft(null); return; }
    setReview(current);
    setTaskDraft(current.task);
  }, [items, review?.batch.id, review?.task.taskId]);

  function openTask(item: InboxItem) {
    setReview(item);
    setTaskDraft({ ...item.task });
    setEvidence(Object.fromEntries(responseRecords(item.task).flatMap((response) => {
      const imported = importedResponse(response.attempt);
      return imported === undefined ? [] : [[response.key, imported]];
    })));
  }
  function closeTask() { setReview(null); setTaskDraft(null); setEvidence({}); }

  async function saveIssue() {
    if (!review || !taskDraft || !issueComplete(taskDraft)) return;
    const updatedAt = new Date().toISOString();
    const saved = await training.actions.saveContinualLearningDailyBatch({ ...review.batch, tasks: review.batch.tasks.map((task) => task.taskId === taskDraft.taskId ? taskDraft : task), revision: review.batch.revision + 1, updatedAt });
    if (!saved) return;
    closeTask();
    onToast("Issue review saved.", "success");
  }

  async function queueTasks() {
    const chosen = items.filter((item) => selected.has(itemKey(item)) && canStage(item.task));
    if (!chosen.length) return;
    const stagedAt = new Date().toISOString();
    const touched = new Map(chosen.map((item) => [item.batch.id, item.batch]));
    let count = 0;
    for (const batch of touched.values()) {
      const saved = await training.actions.saveContinualLearningDailyBatch({ ...batch, tasks: batch.tasks.map((task) => selected.has(`${batch.id}:${task.taskId}`) && canStage(task) ? { ...task, stagedAt } : task), revision: batch.revision + 1, updatedAt: stagedAt });
      if (saved) count += saved.tasks.filter((task) => task.stagedAt === stagedAt).length;
    }
    if (count) { setSelected(new Set()); onToast(`${count} task${count === 1 ? "" : "s"} staged for training.`, "success"); }
  }

  async function loadInteraction(key: string, attempt: CapturedAttempt) {
    if (attempt.source === "imported_response") { setEvidence((current) => ({ ...current, [key]: attempt.response })); return; }
    const result = await training.actions.loadComparisonAttemptEvidence({ runId: attempt.evaluationRunId, attemptId: attempt.attemptId, kind: "transcript" });
    setEvidence((current) => ({ ...current, [key]: result?.value ?? result }));
  }

  const selectable = items.filter((item) => canSelect(item.task));
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(itemKey(item)));
  const selectedItems = items.filter((item) => selected.has(itemKey(item)));
  const selectedCanQueue = selectedItems.length > 0 && selectedItems.every((item) => canStage(item.task));
  return <div className="labs-daily-evals">
    {items.length ? <>
      <div className="training-table-wrap labs-daily-issues-table-wrap"><table className="training-data-table labs-daily-issues-table">
        <thead><tr><th className="labs-checkbox-cell"><input aria-label="Select all available issues" checked={allSelected} className="training-chat-checkbox" type="checkbox" onChange={(event) => setSelected(event.currentTarget.checked ? new Set(selectable.map(itemKey)) : new Set())} /></th><th>Issue</th><th>Received</th><th>Customer request</th><th>Responses</th><th>Decision</th><th /></tr></thead>
        <tbody>{items.map((item) => { const key = itemKey(item); return <tr key={key}>
          <td className="labs-checkbox-cell"><input aria-label={`Select ${item.task.taskId}`} checked={selected.has(key)} className="training-chat-checkbox" disabled={!canSelect(item.task)} type="checkbox" onChange={(event) => setSelected((current) => toggled(current, key, event.currentTarget.checked))} /></td>
          <td><strong>{item.task.taskId}</strong><small>{intakeState(item.batch, item.task)}</small></td>
          <td>{formatDateTime(item.batch.availableAt)}</td><td><span className="labs-daily-request-preview">{promptFor(item.source ?? undefined)}</span></td>
          <td>{responseSummary(item.task, item.batch.intakeEvaluation.status)}</td>
          <td>{formatDisposition(item.task.disposition)}</td><td><button className="training-button secondary labs-evals-review-button" disabled={item.batch.intakeEvaluation.status === "running"} type="button" onClick={() => openTask(item)}>Review</button></td>
        </tr>; })}</tbody>
      </table></div>
      <div className="labs-daily-workflow-actions"><button className="training-button secondary" type="button" onClick={() => onOpenSeries(series.id)}>Open model timeline</button><button className="training-button" disabled={!selectedCanQueue || training.busyAction !== null} title={selected.size && !selectedCanQueue ? "Review selected tasks and include them in training before queueing." : undefined} type="button" onClick={() => void queueTasks()}>Queue tasks{selected.size ? ` (${selected.size})` : ""}</button></div>
    </> : <div className="labs-daily-empty"><strong>No issues yet.</strong><p>Upload tasks to add them to this model’s evaluation inbox.</p></div>}

    {review && taskDraft && review.source && review.taskset ? <AppDialog ariaLabel={`Review ${review.source.id}`} backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-evals-review-dialog" dismissDisabled={training.busyAction !== null} onClose={closeTask}>
        <header><div><p>Incoming customer issue</p><h2>{review.source.id}</h2></div><button aria-label="Close issue" disabled={training.busyAction !== null} type="button" onClick={closeTask}><X size={16} /></button></header>
        <div className="labs-issue-review-dialog-body">
          <section className="labs-daily-review-section"><h4>Customer request</h4><p>{promptFor(review.source)}</p></section>
          <section className="labs-daily-review-section"><h4>Model responses</h4><div className="labs-response-comparison-grid">{responseRecords(taskDraft).map((response) => <AttemptPanel attempt={response.attempt} evidence={evidence[response.key]} key={response.key} label={response.label} onLoad={() => void loadInteraction(response.key, response.attempt)} />)}{!responseRecords(taskDraft).length ? <p className="labs-daily-empty-interaction">No model responses have been generated or imported for this task.</p> : null}</div></section>
          <section className="labs-daily-review-section labs-daily-oracle"><div><h4>Expected outcome</h4><p>The Taskset’s privileged oracle and grader determine what should happen. Confirm it or flag a correction.</p></div><OracleSummary task={review.source} taskset={review.taskset} /><div className="labs-choice-row" aria-label="Oracle review"><button className={taskDraft.oracleReview === "confirmed" ? "selected" : undefined} type="button" onClick={() => setTaskDraft({ ...taskDraft, oracleReview: "confirmed" })}>Oracle looks right</button><button className={taskDraft.oracleReview === "needs_correction" ? "selected warning" : undefined} type="button" onClick={() => setTaskDraft({ ...taskDraft, oracleReview: "needs_correction" })}>Needs correction</button></div></section>
          <section className="labs-daily-review-section"><h4>Learning decision</h4><div className="labs-choice-row" aria-label="Learning decision">{(["include", "defer", "exclude"] as const).map((disposition) => <button className={taskDraft.disposition === disposition ? "selected" : undefined} key={disposition} type="button" onClick={() => setTaskDraft({ ...taskDraft, disposition })}>{disposition === "include" ? "Include in training" : disposition === "defer" ? "Defer" : "Exclude"}</button>)}</div><label className="labs-daily-note"><span>{taskDraft.oracleReview === "needs_correction" ? "Correction note (required)" : "Reviewer note (optional)"}</span><textarea value={taskDraft.note} onChange={(event) => setTaskDraft({ ...taskDraft, note: event.currentTarget.value })} /></label></section>
        </div><footer><button disabled={training.busyAction !== null} type="button" onClick={closeTask}>Cancel</button><button disabled={!hasResponse(taskDraft) || !issueComplete(taskDraft) || training.busyAction !== null} type="submit" onClick={() => void saveIssue()}>Save</button></footer>
      </AppDialog> : null}
  </div>;
}

function AttemptPanel({ attempt, evidence, label, onLoad }: { attempt: CapturedAttempt; evidence: unknown; label: string; onLoad: () => void }) {
  return <article className="labs-response-panel"><header><div><h5>{label}</h5>{attempt.modelLabel && attempt.modelLabel !== label ? <small>{attempt.modelLabel}</small> : null}</div><strong>{formatPercentage(attempt.reward)}</strong></header><RewardComponents components={attempt.components} />{evidence !== undefined ? <pre>{readable(evidence)}</pre> : <button className="training-button secondary" type="button" onClick={onLoad}>View response</button>}</article>;
}
function RewardComponents({ components }: { components: Record<string, number> }) { const rows = Object.entries(components); return rows.length ? <dl className="labs-reward-components">{rows.map(([label, value]) => <div key={label}><dt>{humanize(label)}</dt><dd>{formatPercentage(value)}</dd></div>)}</dl> : <small>No component scores were supplied.</small>; }
function exactTaskset(state: TrainingStateResponse, ref: { id: string; revision: number; contentHash: string }): Taskset | null { return [...state.tasksets, ...state.modelTasksets].find((taskset) => taskset.id === ref.id && taskset.revision === ref.revision && taskset.contentHash === ref.contentHash) ?? null; }
function promptFor(task?: TaskDataRecord): string { if (!task) return "Task details unavailable"; const prompt = task.input.prompt ?? task.input.request ?? task.input.messages; return typeof prompt === "string" ? prompt : readable(prompt ?? task.input); }
function OracleSummary({ task, taskset }: { task: TaskDataRecord; taskset: Taskset }) { const expected = task.expectedOutput ?? task.metadata.expectedOutcome ?? task.metadata.oracle ?? task.metadata.evaluationCriteria; return <div className="labs-oracle-summary">{expected ? <pre>{readable(expected)}</pre> : <p>The expected outcome is enforced by the Taskset’s privileged grader. This release does not include a human-readable oracle summary.</p>}<small>{taskset.graders.length} grader{taskset.graders.length === 1 ? "" : "s"} · Grader evidence remains attached to the Taskset release.</small></div>; }
function importedResponse(attempt: CapturedAttempt | null): unknown { return attempt?.source === "imported_response" ? attempt.response : undefined; }
function readable(value: unknown): string { if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function formatPercentage(value: number | null): string { return value === null ? "—" : `${Math.round(value * 100)}%`; }
function responseSummary(task: IntakeTask, status: ContinualLearningDailyBatch["intakeEvaluation"]["status"]): string { const responses = responseRecords(task); if (!responses.length) { if (status === "running") return "Generating…"; if (status === "failed") return "Failed"; return "Not generated"; } const scored = responses.map(({ attempt }) => attempt.reward).filter((value): value is number => value !== null).sort((a, b) => a - b); if (!scored.length) return `${responses.length} response${responses.length === 1 ? "" : "s"}`; const range = scored[0] === scored.at(-1) ? formatPercentage(scored[0]!) : `${formatPercentage(scored[0]!)}–${formatPercentage(scored.at(-1)!)}`; return `${responses.length} · ${range}`; }
function formatDisposition(value: IntakeTask["disposition"]): string { return value === "include" ? "Include" : value === "defer" ? "Defer" : value === "exclude" ? "Exclude" : "Not reviewed"; }
function issueComplete(task: IntakeTask): boolean { return task.disposition !== null && task.oracleReview !== "pending" && (task.oracleReview !== "needs_correction" || task.note.trim().length > 0); }
function hasResponse(task: IntakeTask): boolean { return responseRecords(task).length > 0; }
function canSelect(task: IntakeTask): boolean { return !task.stagedAt && !task.queuedEntry; }
function canStage(task: IntakeTask): boolean { return issueComplete(task) && task.disposition === "include" && !task.stagedAt && !task.queuedEntry; }
function itemKey(item: InboxItem): string { return `${item.batch.id}:${item.task.taskId}`; }
function toggled(current: Set<string>, key: string, checked: boolean): Set<string> { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next; }
function intakeState(batch: ContinualLearningDailyBatch, task: IntakeTask): string { if (task.queuedEntry) return "Training queued"; if (task.stagedAt) return "Staged"; if (batch.intakeEvaluation.status === "running") return "Generating responses"; if (batch.intakeEvaluation.status === "failed") return "Generation failed"; return task.oracleReview === "confirmed" ? "Oracle confirmed" : task.oracleReview === "needs_correction" ? "Oracle needs correction" : "Awaiting review"; }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function humanize(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function responseRecords(task: IntakeTask): ResponseRecord[] {
  if (task.responses.length) return task.responses.map(({ target, attempt }) => ({ key: `${target.kind}:${target.id}`, label: target.label, attempt }));
  const legacy = [task.baselineAttempt, task.observedAttempt].filter((attempt): attempt is CapturedAttempt => attempt !== null);
  return legacy.map((attempt, index) => ({ key: `legacy:${index}`, label: attempt.modelLabel ?? `Model response ${index + 1}`, attempt }));
}
