import { useQuery } from "@tanstack/react-query";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { useState } from "react";
import { TasksetGraderDetailsResponseSchema, type Taskset } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

type SavedInput = Pick<Taskset, "id" | "profileId" | "name" | "revision" | "contentHash" | "tasks" | "graders">;
/** Model-owned local tasksets retain their own authority and revision; they are
 * never presented as independent authoring datasets or hosted release IDs. */
export function PonderSavedTaskset({ taskset, tab, connection }: { connection: ClientConnection; taskset: SavedInput; tab: "dataset" | "graders" }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [taskId, setTask] = useState<string>();
  const [graderId, setGrader] = useState<string>();
  const filtered = taskset.tasks.filter(item => `${item.id} ${JSON.stringify(item.input)}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const current = Math.min(page, pages - 1);
  const task = taskset.tasks.find(item => item.id === taskId);
  const grader = taskset.graders.find(item => item.id === graderId) ?? taskset.graders[0];
  const source = useQuery({ queryKey: ["ponder-model-grader-source", connectionQueryScope(connection), taskset.profileId, taskset.id, taskset.revision, taskset.contentHash],
    enabled: tab === "graders" && taskset.graders.some(item => item.kind === "custom_verifier"), staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const value = TasksetGraderDetailsResponseSchema.parse(await apiFetch(connection, `/v1/training/tasksets/${encodeURIComponent(taskset.id)}/graders`, { signal }));
      if (value.taskset.id !== taskset.id || value.taskset.revision !== taskset.revision || value.taskset.contentHash !== taskset.contentHash)
        throw new Error("Grader source is for another dataset revision. Reopen the model to inspect its current inputs.");
      if (value.sources.some(item => item.integrity === "mismatch")) throw new Error("Grader source differs from its pinned hash.");
      return value;
    } });
  return <>
    <p>{taskset.name} · Local model dataset · revision {taskset.revision} · {taskset.tasks.length} tasks</p>
    {tab === "dataset" ? <>
      <input className="training-input" aria-label="Search model dataset tasks" placeholder="Search tasks" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} />
      <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table ponder-task-table"><thead><tr><th>Task</th><th>Input</th><th>Split</th></tr></thead><tbody>
        {filtered.slice(current * 20, current * 20 + 20).map(item => <tr key={item.id}><td><button type="button" className="training-text-button" onClick={() => setTask(item.id)}>{item.id}</button></td><td><span className="ponder-task-preview">{JSON.stringify(item.input).slice(0, 180)}</span></td><td>{item.split}</td></tr>)}
      </tbody></table></div>
      {!filtered.length ? <p>No matching tasks.</p> : null}
      {pages > 1 ? <div className="training-rollout-pagination"><button type="button" disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>Page {current + 1} of {pages}</span><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next</button></div> : null}
      {task ? <section><h3>{task.id}</h3><MarkdownCodeBlock language="json" content={JSON.stringify(task, null, 2)} /></section> : null}
    </> : <>
      {grader ? <><DropdownSelect label="Grader" floating searchable value={grader.id} options={taskset.graders.map(item => ({ value: item.id, label: item.id, description: item.kind }))} onChange={setGrader} />
        <MarkdownCodeBlock language="json" content={JSON.stringify(grader, null, 2)} />
        <ErrorToast error={source.error}>{source.error ? <button type="button" className="training-button secondary" onClick={() => void source.refetch()}>Retry grader source</button> : null}</ErrorToast>
        {source.isFetching ? <p role="status">Loading grader source…</p> : null}
        {source.data?.sources.filter(item => item.graderId === grader.id).map(item => <section key={item.path}><h3>{item.path}</h3><MarkdownCodeBlock language={item.language} content={item.content.slice(0, 24_000)} /><small>{item.integrity} · SHA-256 {item.sha256}{item.content.length > 24_000 ? " · Preview truncated" : ""}</small></section>)}
        </> : <p>No graders attached.</p>}
    </>}
  </>;
}
