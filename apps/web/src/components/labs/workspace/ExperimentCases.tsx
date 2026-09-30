import { EvaluationCard, EvaluationStatus } from "./EvaluationPresentation";
import { GraderReleasePicker } from "./GraderReleasePicker";
import { GraderFieldMappings } from "./GraderFieldMappings";
import { learningRef, type RewardRelease } from "openpond-sdk/learning";
import { ExperimentFieldMappingsSchema, type ExperimentFieldMapping } from "openpond-sdk/experiments";
import { useQuery } from "@tanstack/react-query";
import type { ExperimentCaseInspection } from "openpond-sdk/experiments";
import { WorkspacePanel } from "./WorkspacePanel";
import { useState } from "react";
import { type ExperimentDefinition, type ExperimentScoringPass } from "openpond-sdk/experiments";
import type { ModelTasksetRunDetails } from "openpond-sdk/model-taskset-runs";
import type { ExperimentEvidence, WorkspaceApi } from "./workspace-api";
export function ExperimentCases({ evidence, api, execution, saved, busy, onScore, onSelectPass }: { evidence: ExperimentEvidence; api: WorkspaceApi; execution: ModelTasksetRunDetails | null; saved: ExperimentDefinition; busy: boolean; onScore: (action: () => Promise<void>) => void; onSelectPass: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [selectingGrader, setSelectingGrader] = useState(false);
  const [newGrader, setNewGrader] = useState<RewardRelease | null>(null);
  const [newMappings, setNewMappings] = useState<ExperimentFieldMapping[]>([]);
  const [scoreBudget, setScoreBudget] = useState(saved.maximumCostUsd);
  const cases = evidence.result.cases;
  const [eventCursor, setEventCursor] = useState<string | undefined>();
  const item = cases.find(row => JSON.stringify(row.identity) === selected);
  const population = execution?.request.population.find(member => member.taskId === item?.identity.caseId && member.seed === item.identity.seed && member.fixtureId === item.identity.fixtureId);
  const inspection = useQuery({ queryKey: ["evaluation-workspace", api.key, "case", execution?.summary.id, population?.receiptId, eventCursor], enabled: Boolean(execution && population), queryFn: ({ signal }) => api.request<ExperimentCaseInspection>("case", { id: execution!.summary.id, receiptId: population!.receiptId, ...(eventCursor ? { afterId: eventCursor } : {}) }, signal) });
  const totalTokens = cases.every(row => row.usage.totalTokens !== null) ? cases.reduce((total, row) => total + row.usage.totalTokens!, 0) : null;
  const cost = cases.every(row => row.usage.costUsd !== null) ? cases.reduce((total, row) => total + Number(row.usage.costUsd), 0) : null;
  function score(useNewGrader = selectingGrader) {
    if (!execution) return;
    onScore(async () => {
      const graders = useNewGrader ? newGrader ? [learningRef(newGrader)] : [] : saved.graders.flatMap(grader => grader.release ? [grader.release] : []);
      if (!graders.length) throw new Error("Select a published reusable grader for a retained-output scoring pass.");
      const fields = useNewGrader && newGrader ? [{ graderId: newGrader.id, fields: ExperimentFieldMappingsSchema.parse(newMappings) }] : saved.graders.flatMap(grader => grader.release ? [{ graderId: grader.release.id, fields: grader.mappings ?? [] }] : []);
      const request = { execution: { id: execution.summary.id, contentHash: execution.summary.manifestHash }, graders, maximumCostUsd: scoreBudget, mappings: fields };
      const operation = api.operation("score", request);
      const pass = await api.request<ExperimentScoringPass>("score", { ...request, operationId: operation.id });
      operation.acknowledge(); setSelectingGrader(false); onSelectPass(pass.id);
    });
  }
  return <><p>{cases.length} retained cases · {totalTokens === null ? "Tokens unknown" : `${totalTokens.toLocaleString()} recorded tokens`} · {cost === null ? "Spend unknown" : `$${cost.toFixed(6)} recorded spend`}</p><button className="training-button secondary" disabled={busy || !execution} onClick={() => setSelectingGrader(true)}>Apply a different grader</button><div className="evaluation-workspace-scope"><label>Grading budget ($) <input type="number" min="0.000001" step="0.000001" value={scoreBudget} onChange={event => setScoreBudget(Number(event.target.value))} /></label><button className="training-button secondary" disabled={busy || !execution || !saved.graders.some(grader => grader.release)} onClick={() => { setSelectingGrader(false); score(false); }}>Reapply saved graders</button></div>
    {selectingGrader ? <WorkspacePanel label="Retained output grading"><header><h2>Apply grader</h2><button disabled={busy} onClick={() => setSelectingGrader(false)}>Close</button></header><EvaluationCard title="Grader and version"><GraderReleasePicker api={api} value={newGrader} onChange={setNewGrader} /></EvaluationCard><EvaluationCard title="Field mappings"><GraderFieldMappings value={newMappings} onChange={setNewMappings} /></EvaluationCard><EvaluationCard title="Grading budget"><label>Grading cost limit ($)<input type="number" min="0.000001" step="0.000001" value={scoreBudget} onChange={event => setScoreBudget(Number(event.target.value))} /></label><p>This creates a separate scoring pass against retained outputs. Original results keep their grader pins.</p></EvaluationCard><button className="training-button" disabled={busy || !newGrader || !ExperimentFieldMappingsSchema.safeParse(newMappings).success} onClick={() => score(true)}>Grade retained output</button></WorkspacePanel> : null}
    <table className="training-data-table evaluation-workspace-table"><thead><tr><th>Case</th><th>Status</th>{evidence.manifest.evaluators.map(grader => <th key={grader.feedbackKey}>{grader.feedbackKey}</th>)}<th>Tokens</th><th>Spend</th></tr></thead><tbody>{cases.map(row => { const key = JSON.stringify(row.identity); return <tr key={key} tabIndex={0} onClick={() => { setSelected(key); setEventCursor(undefined); }} onKeyDown={event => { if (event.key === "Enter") { setSelected(key); setEventCursor(undefined); } }}><td>{row.identity.caseId} · Seed {row.identity.seed}</td><td><EvaluationStatus status={row.status} /></td>{evidence.manifest.evaluators.map(grader => { const feedback = row.feedback.find(value => value.feedbackKey === grader.feedbackKey); return <td key={grader.feedbackKey}>{feedback?.status === "scored" ? String(feedback.value) : feedback?.status ?? "Not scored"}</td>; })}<td>{row.usage.totalTokens ?? "Unknown"}</td><td>{row.usage.costUsd === null ? "Unknown" : `$${Number(row.usage.costUsd).toFixed(6)}`}</td></tr>; })}</tbody></table>
    {item && !selectingGrader ? <WorkspacePanel label="Case inspector"><header><h2>{item.identity.caseId}</h2><button onClick={() => setSelected(null)}>Close</button></header><p><EvaluationStatus status={item.status} /></p>{inspection.error ? <p role="alert">{inspection.error.message}</p> : null}<h3>Retained input</h3>{inspection.data?.input ? <pre>{JSON.stringify(inspection.data.input, null, 2)}</pre> : <p>{inspection.isPending ? "Loading retained input…" : "Input not retained."}</p>}<EvaluationCard title="Output"><pre>{typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)}</pre></EvaluationCard>{item.error ? <p role="alert">{item.error.code}: {item.error.message}</p> : null}{item.feedback.map(feedback => <section key={feedback.feedbackKey}><h3>{feedback.feedbackKey}</h3><p>{feedback.status} · {feedback.value === null ? "No score" : String(feedback.value)}{feedback.passed === null || feedback.passed === undefined ? "" : feedback.passed ? " · Pass" : " · Fail"}</p>{feedback.reasoning ? <p>{feedback.reasoning}</p> : null}</section>)}<EvaluationCard title="Usage"><pre>{JSON.stringify(item.usage, null, 2)}</pre></EvaluationCard><h3>Available trace</h3>{inspection.data?.events.length ? <ol>{inspection.data.events.map((event, index) => <li key={String(event.id ?? event.sequence ?? index)}><pre>{JSON.stringify(event, null, 2)}</pre></li>)}</ol> : <p>No trace events retained for this case.</p>}{eventCursor ? <button onClick={() => setEventCursor(undefined)}>First trace page</button> : null}{inspection.data?.nextEventCursor ? <button onClick={() => setEventCursor(inspection.data!.nextEventCursor!)}>Next trace page</button> : null}{item.traceRef ? <details><summary>Trace identity</summary><pre>{JSON.stringify(item.traceRef, null, 2)}</pre></details> : null}<h3>Artifacts</h3><pre>{JSON.stringify(item.feedback.flatMap(feedback => feedback.evidenceRefs), null, 2)}</pre></WorkspacePanel> : null}
  </>;
}
