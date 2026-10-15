import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatResourceSummary } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { chatResourceRequest, type DatasetResponse } from "../../api/chat-resource-api";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { resourceIdentity } from "./dataset-workspace-data";

function ExampleInput({ input, id }: { input: Record<string, unknown>; id: string }) {
  const prompt = typeof input.prompt === "string" ? input.prompt : typeof input.request === "string" ? input.request : null;
  const fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "prompt" && key !== "request"));
  const hasFields = Object.keys(fields).length > 0;
  return <>
    <div tabIndex={0} aria-label={`Input for ${id}`}>{hasFields ? JSON.stringify(fields, null, 2) : prompt ?? JSON.stringify(input, null, 2)}</div>
    {hasFields && prompt ? <details><summary>Full prompt</summary><pre>{prompt}</pre></details> : null}
  </>;
}

/** Inspect the selected immutable revision without changing its scope or pins. */
export function DatasetRowPreview({ connection, dataset }: { connection: ClientConnection; dataset: ChatResourceSummary }) {
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: ["training-dataset-rows", connectionQueryScope(connection), resourceIdentity(dataset), dataset.revision],
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const result = await chatResourceRequest<DatasetResponse>(connection, "dataset", { action: "read", id: dataset.id, expectedRevision: dataset.revision }, signal);
      if (resourceIdentity(result.summary) !== resourceIdentity(dataset) || result.summary.revision !== dataset.revision) throw new Error("Dataset rows do not match the selected revision.");
      return result;
    },
  });
  const tasks = query.data?.record.workspace.draft.tasks ?? [];
  const pages = Math.max(1, Math.ceil(tasks.length / 5));
  const currentPage = Math.min(page, pages - 1);
  return <section className="dataset-row-preview" aria-label={`Examples from ${dataset.name}, revision ${dataset.revision}`}>
    <ErrorToast error={query.error?.message}>{query.error ? <button type="button" className="training-button secondary" onClick={() => void query.refetch()}>Retry rows</button> : null}</ErrorToast>
    <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table">
      <thead><tr><th>Example</th><th>Input</th><th>Split</th></tr></thead>
      <tbody>{tasks.slice(currentPage * 5, currentPage * 5 + 5).map((task) => <tr key={task.id}>
        <td>{task.id}</td>
        <td><ExampleInput input={task.input} id={task.id} />
          {task.expectedOutput ? <details><summary>Expected output</summary><pre>{JSON.stringify(task.expectedOutput, null, 2)}</pre></details> : null}
        </td><td>{task.split}</td>
      </tr>)}</tbody>
    </table></div>
    {query.isPending ? <p role="status">Loading examples…</p> : !tasks.length && !query.error ? <p>No saved examples.</p> : null}
    {pages > 1 ? <div className="training-rollout-pagination">
      <button type="button" className="training-button secondary" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <span>{currentPage * 5 + 1}–{Math.min(tasks.length, (currentPage + 1) * 5)} of {tasks.length}</span>
      <button type="button" className="training-button secondary" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Next</button>
    </div> : null}
  </section>;
}
