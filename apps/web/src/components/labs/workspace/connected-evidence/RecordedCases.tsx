import { useState } from "react";
import type { ExperimentResult } from "@openpond/evals/experiments";
import type { ConnectedRecordedExecution } from "openpond-sdk/connected-evidence";
import type { HumanReviewView } from "@openpond/evals/human-review";
import type { ExperimentScoringPass } from "openpond-sdk/experiments";
import type { WorkspaceApi } from "../workspace-api";
import { WorkspacePanel, useWorkspaceActions } from "../WorkspacePanel";
import { ConnectedCaseInspector } from "./ConnectedCaseInspector";
import { RecordedGrading } from "./ConnectedRecordedSetup";
import { HumanResultControls } from "../../../human-review/HumanResultControls";
import { HumanReviewLaunch } from "../../../human-review/HumanReviewLaunch";
import { HumanReviewInspector } from "../../../human-review/HumanReviewInspector";
import { useHumanGraderChoices } from "../../../human-review/useHumanGraderChoices";
import { humanApi } from "../../../human-review/api";

export function RecordedCases({ api, execution, result, onSelectPass }: { api: WorkspaceApi; execution: ConnectedRecordedExecution; result: ExperimentResult; onSelectPass(id: string): void }) {
  const [filter, setFilter] = useState("all"), [page, setPage] = useState(0), [source, setSource] = useState<ConnectedRecordedExecution["sources"][number] | null>(null), [grading, setGrading] = useState(false), [review, setReview] = useState<HumanReviewView | null>(null), [error, setError] = useState<string | null>(null);
  const context = api.humanContext ?? undefined, choices = useHumanGraderChoices(context, execution.request.projectId, execution.manifest.dataset);
  useWorkspaceActions([{ id: "recorded-grader", label: "Grader", onSelect: () => setGrading(true) }]);
  async function openReview(id: string) { if (!context) return; try { setError(null); setReview(await humanApi.get(context, id)); } catch (failure) { setError(failure instanceof Error ? failure.message : "Review unavailable."); } }
  const sources = new Map(execution.sources.map(item => [item.boundaryId, item])), visible = result.cases.filter(item => filter === "all" || item.status === filter), maxPage = Math.max(0, Math.ceil(visible.length / 50) - 1), current = Math.min(page, maxPage);
  return <section>{context ? <HumanResultControls context={context} executionId={execution.id} onOpenReview={id => void openReview(id)} /> : null}
    {error || choices.error ? <p role="alert">{error ?? choices.error}</p> : null}
    <div className="evaluation-workspace-scope"><label>Status<select value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}><option value="all">All statuses</option>{[...new Set(result.cases.map(item => item.status))].map(status => <option key={status} value={status}>{status}</option>)}</select></label><button className="training-button secondary" onClick={() => setGrading(true)}>Apply another grader</button><span>{result.cases.length} frozen recorded cases</span></div>
    <table className="training-data-table"><thead><tr><th>Case</th><th>Status</th><th>Feedback</th><th>Evidence and review</th></tr></thead><tbody>{visible.slice(current * 50, (current + 1) * 50).map(item => {
      const matched = sources.get(item.identity.caseId); return <tr key={JSON.stringify(item.identity)}><td>{item.identity.caseId}</td><td>{item.status}</td><td>{item.feedback.map(feedback => <div key={feedback.feedbackKey}>{feedback.feedbackKey}: {feedback.status}{feedback.value === null ? "" : ` (${JSON.stringify(feedback.value)})`}{feedback.reasoning ? <details><summary>Reasoning</summary><p>{feedback.reasoning}</p></details> : null}</div>)}</td><td><button disabled={!matched} onClick={() => setSource(matched!)}>Inspect input and trace</button>{context && matched ? <HumanReviewLaunch context={context} projectId={execution.request.projectId} selections={[{ executionId: execution.id, receiptId: matched.boundaryId }]} graders={choices.choices} onOpenReview={setReview} /> : null}{!matched ? <p role="alert">No retained source matches this result identity.</p> : null}</td></tr>;
    })}</tbody></table><button disabled={!current} onClick={() => setPage(current - 1)}>Previous cases</button><span>Page {current + 1} of {maxPage + 1}</span><button disabled={current === maxPage} onClick={() => setPage(current + 1)}>More cases</button>
    {source ? <ConnectedCaseInspector api={api} evidenceRef={{ id: source.id, snapshotHash: source.snapshotHash, boundaryId: source.boundaryId, boundaryRevisionHash: source.boundaryRevisionHash }} onClose={() => setSource(null)} /> : null}
    {grading ? <WorkspacePanel action="recorded-grader" label="Apply grader" onRequestClose={() => setGrading(false)}><RecordedGrading api={api} execution={execution} onStarted={(pass: ExperimentScoringPass) => { setGrading(false); onSelectPass(pass.id); }} /></WorkspacePanel> : null}
    {context && review ? <WorkspacePanel action="human-review" label={review.title} onRequestClose={() => setReview(null)}><HumanReviewInspector context={context} record={review} onChanged={setReview} onClose={() => setReview(null)} /></WorkspacePanel> : null}
  </section>;
}
