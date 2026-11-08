import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatResourceSummary, TaskResourceContext } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { chatResourceRequest } from "../../api/chat-resource-api";
import { connectionQueryScope } from "../../lib/query-scope";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { addResourceRequestToChat } from "./composer-resource-request";

type Inspection = { grader: Record<string, unknown>; fixtures: { total: number; items: { id: string; label: string; output: unknown; expectedPassed?: boolean }[]; hasMore: boolean };
  files: { path: string; content: string; truncated: boolean }[] };
export function PonderGraderInspector({ connection, dataset, graders, sessionId, contexts, hostedEditor }: {
  connection: ClientConnection; dataset: ChatResourceSummary; graders: ChatResourceSummary[]; sessionId: string | null; contexts: TaskResourceContext[]; hostedEditor?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const grader = graders.find(item => item.id === selected) ?? graders[0];
  const query = useQuery({ queryKey: ["ponder-grader", connectionQueryScope(connection), dataset.id, dataset.revision, grader?.id, offset],
    enabled: Boolean(grader),
    queryFn: ({ signal }) => chatResourceRequest<Inspection>(connection, "dataset", {
      action: "read_grader", id: dataset.id, expectedRevision: dataset.revision,
      payload: { graderId: grader!.graderId, view: "inspection", offset, limit: 20 },
    }, signal) });
  function request(action: string) {
    if (!grader) return;
    addResourceRequestToChat({ sessionId, text: `${action} ${grader.name} (${grader.graderId}) for ${dataset.name}, revision ${dataset.revision}. Read its exact definition, verifier files, calibration fixtures and retained results first. Save edits as a new dataset revision and preserve old run inputs. Do not weaken acceptance criteria to increase scores. Ask for any required fixture-check budget before paid testing.`,
      contexts,
    });
  }
  return <>
    <p>{dataset.name} · revision {dataset.revision}. Graders are attached to this exact revision.</p>
    {hostedEditor ? <a className="training-text-button" href={hostedEditor} target="_blank" rel="noreferrer">Create or manage graders in OpenPond</a> : null}
    {graders.length ? <DropdownSelect label="Grader" floating searchable value={grader!.id}
      options={graders.map(item => ({ value: item.id, label: item.name, description: `${item.graderType ?? "Grader"} · ${item.checkState ?? item.state}` }))}
      onChange={value => { setSelected(value); setOffset(0); }} /> : <p>No graders attached.</p>}
    <ErrorToast error={query.error}>{query.error ? <button type="button" onClick={() => void query.refetch()}>Retry grader</button> : null}</ErrorToast>
    {grader ? <div className="ponder-workbench-actions"><button type="button" className="training-button secondary" onClick={() => request("Edit grader")}>Edit in chat</button>
      <button type="button" className="training-button secondary" onClick={() => request("Test grader")}>Test in chat</button></div> : null}
    {grader && query.isPending ? <p role="status">Loading grader…</p> : null}
    {query.data ? <>
      <h3>Definition</h3><MarkdownCodeBlock language="json" content={JSON.stringify(query.data.grader, null, 2)} />
      {query.data.files.map(file => <section key={file.path}><h3>{file.path}</h3><MarkdownCodeBlock language={file.path.endsWith(".py") ? "python" : "javascript"} content={file.content} />{file.truncated ? <p>Source preview truncated. Use the exact file through chat to inspect the complete verifier.</p> : null}</section>)}
      <h3>Calibration examples</h3><div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table ponder-calibration-table"><thead><tr><th>Example</th><th>Output</th><th>Expected pass</th></tr></thead>
        <tbody>{query.data.fixtures.items.map(item => <tr key={item.id}><td>{item.label}</td><td><pre>{JSON.stringify(item.output, null, 2)}</pre></td><td>{item.expectedPassed === undefined ? "—" : item.expectedPassed ? "Yes" : "No"}</td></tr>)}</tbody></table></div>
      {!query.data.fixtures.total ? <p>No calibration examples saved.</p> : null}
      {offset > 0 || query.data.fixtures.hasMore ? <div className="training-rollout-pagination"><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button><span>{offset + 1}–{Math.min(offset + 20, query.data.fixtures.total)} of {query.data.fixtures.total}</span><button type="button" disabled={!query.data.fixtures.hasMore} onClick={() => setOffset(offset + 20)}>Next</button></div> : null}
    </> : null}
  </>;
}
