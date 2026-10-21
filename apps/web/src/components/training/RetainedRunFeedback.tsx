import { createContext, useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RunGraderFeedbackSchema, type RunFeedbackTarget, type RunGraderFeedback } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { DropdownSelect } from "../DropdownSelect";

export const RunEvidenceContext = createContext<{ connection: ClientConnection; teamId: string; jobId: string } | null>(null);
export function RetainedRunFeedback({ targets }: { targets?: RunFeedbackTarget[] }) {
  const scope = useContext(RunEvidenceContext);
  return scope && targets?.length ? <FeedbackReader {...scope} targets={targets} /> : null;
}

function FeedbackReader({ connection, teamId, jobId, targets }: { connection: ClientConnection; teamId: string; jobId: string; targets: RunFeedbackTarget[] }) {
  const [selection, setSelection] = useState(() => JSON.stringify(targets[0]));
  const target = targets.find(item => JSON.stringify(item) === selection) ?? targets[0]!;
  const query = useQuery({
    queryKey: ["retained-run-feedback", connectionQueryScope(connection), teamId, jobId, target.kind, target.id, target.taskId ?? null],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ teamId, kind: target.kind, id: target.id, ...(target.taskId ? { taskId: target.taskId } : {}) });
      const value = RunGraderFeedbackSchema.parse(await apiFetch(connection, `/v1/training/hosted-jobs/${encodeURIComponent(jobId)}/feedback?${params}`, { signal }));
      if (value.jobId !== jobId || value.id !== target.id || value.kind !== target.kind || value.taskId !== target.taskId) throw new Error("Grader feedback belongs to another run or attempt.");
      return value;
    },
    staleTime: Infinity, gcTime: 300000, retry: false,
  });
  return <section className="retained-run-feedback">
    <h3>Retained grader feedback</h3>
    {targets.length > 1 ? <DropdownSelect label="Feedback record" value={JSON.stringify(target)} options={targets.map(item => ({ value: JSON.stringify(item), label: item.kind === "trajectory" ? `Trajectory ${item.id.slice(0, 6)}…` : `Task ${item.taskId?.slice(0, 6)}… · evaluation ${item.id.slice(0, 6)}…` }))} onChange={setSelection} /> : null}
    <ErrorToast error={query.error} />
    {query.isPending ? <p role="status">Loading verified grader receipt…</p> : null}
    {query.isError ? <button className="training-button secondary" type="button" onClick={() => void query.refetch()}>Retry grader feedback</button> : null}
    {query.data ? <FeedbackDetails value={query.data} /> : null}
  </section>;
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function FeedbackDetails({ value }: { value: RunGraderFeedback }) {
  return <>
    <p>Training reward: {value.training.status} · score {value.training.score ?? "not retained"}</p>
    <p>Evaluation graders: {value.evaluation.status} · score {value.evaluation.score ?? "not retained"} · recorded aggregate acceptance {value.evaluation.passed === null ? "not retained" : String(value.evaluation.passed)}</p>
    <p className="training-muted">Verified composition {value.compositionSha256.slice(0, 12)}…</p>
    {!value.graders.length ? <p className="training-muted">No grader records retained in this receipt; quality is not established.</p> : null}
    {value.graders.map(grader => <article key={`${grader.role}:${grader.graderId}`}>
      <h4>{grader.graderId} · {grader.role}</h4>
      <p>{grader.status} · raw score {grader.rawScore ?? "not retained"} · normalized score {grader.normalizedScore ?? "not retained"} · grader verdict {grader.passed === true ? "Passed" : grader.passed === false ? "Failed" : "No verdict retained"}</p>
      {grader.message ? <p>{grader.message}</p> : null}
      {grader.failureClass ? <p>Recorded failure: {grader.failureClass}</p> : null}
      {grader.feedback.map((text, index) => <GraderMessage key={index} text={text} />)}
      {!grader.feedback.length ? <p className="training-muted">No feedback text retained by this grader.</p> : null}
    </article>)}
  </>;
}

function GraderMessage({ text }: { text: string }) {
  let parsed: Record<string, unknown> = {};
  try { parsed = record(JSON.parse(text)); } catch { /* Plain grader feedback is evidence too. */ }
  const differences = record(parsed.diagnostics).differences;
  if (!Array.isArray(differences)) return <pre>{text}</pre>;
  return <>
    <dl>{differences.slice(0, 80).map((value, index) => { const item = record(value); return <div key={index}>
      <dt>{typeof item.kind === "string" ? item.kind.replaceAll("_", " ") : "Retained difference"} · {typeof item.path === "string" ? item.path : "Path not retained"}</dt>
      <dd><pre>Expected: {JSON.stringify(item.expected) ?? "Not retained"}{"\n"}Actual: {JSON.stringify(item.actual) ?? "Not retained"}</pre></dd>
    </div>; })}</dl>
    <details><summary>Full retained grader message</summary><pre>{text}</pre></details>
  </>;
}
