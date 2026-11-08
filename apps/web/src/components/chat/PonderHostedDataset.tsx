import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { assertLearningContentHash, learningRef, sameLearningRef } from "openpond-sdk/learning";
import { canonicalJson } from "openpond-sdk/training";
import { DatasetPopulationPageSchema, type DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { WorkspaceApi } from "../labs/workspace/workspace-api";
import { ErrorToast } from "../common/ErrorToast";
import { DropdownSelect } from "../DropdownSelect";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { useWorkspaceLearningClient } from "../labs/workspace/useWorkspaceLearningClient";

export function PonderHostedDataset({ api, release, tab, hostedEditor }: {
  api: WorkspaceApi; release: DatasetPopulationPage["release"]; tab: "dataset" | "graders"; hostedEditor?: string;
}) {
  const [after, setAfter] = useState<string>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [taskId, setTask] = useState<string | null>(null);
  const [graderId, setGrader] = useState<string | null>(null);
  const learning = useWorkspaceLearningClient(api);
  const page = useQuery({ queryKey: ["ponder-hosted-tasks", api.key, release, after], queryFn: async ({ signal }) => {
    const value = DatasetPopulationPageSchema.parse(await api.request("datasetPopulation", { release, view: "policy", limit: 25, ...(after ? { afterId: after } : {}) }, signal));
    if (canonicalJson(value.release) !== canonicalJson(release)) throw new Error("Dataset tasks differ from the selected release.");
    return value;
  } });
  const task = page.data?.items.find(item => item.id === taskId);
  const graders = page.data?.graders ?? [];
  const grader = graders.find(item => item.id === graderId) ?? graders[0];
  const definition = useQuery({ queryKey: ["ponder-hosted-grader", api.key, grader?.release], enabled: tab === "graders" && Boolean(grader?.release),
    queryFn: async ({ signal }) => {
      const pin = grader!.release!;
      const value = await learning.get("reward", pin.id, pin.revision, { signal });
      assertLearningContentHash(value);
      if (!sameLearningRef(learningRef(value), pin)) throw new Error("Grader differs from the selected dataset release.");
      return value;
    } });
  return <>
    <p>Published dataset · revision {release.revision} · {page.data?.taskCount ?? "—"} tasks</p>
    <ErrorToast error={page.error ?? definition.error}>{page.error ? <button type="button" onClick={() => void page.refetch()}>Retry tasks</button> : definition.error ? <button type="button" onClick={() => void definition.refetch()}>Retry grader</button> : null}</ErrorToast>
    {page.isPending ? <p role="status">Loading published tasks…</p> : null}
    {tab === "dataset" ? <>
      <div className="training-table-wrap"><table className="training-data-table evaluation-workspace-table ponder-task-table"><thead><tr><th>Task</th><th>Input</th><th>Split</th></tr></thead><tbody>
        {page.data?.items.map(item => <tr key={item.id}><td><button type="button" className="training-text-button" onClick={() => setTask(item.id)}>{item.id}</button></td><td><span className="ponder-task-preview">{"input" in item ? JSON.stringify(item.input).slice(0, 180) : ""}</span></td><td>{item.split}</td></tr>)}
      </tbody></table></div>
      {page.data && !page.data.items.length ? <p>No tasks in this dataset.</p> : null}
      {previous.length || page.data?.nextCursor ? <div className="training-rollout-pagination"><button type="button" disabled={!previous.length} onClick={() => { setAfter(previous.at(-1)); setPrevious(value => value.slice(0, -1)); setTask(null); }}>Previous</button>
        <span>Page {previous.length + 1}</span><button type="button" disabled={!page.data?.nextCursor} onClick={() => { setPrevious(value => [...value, after]); setAfter(page.data!.nextCursor!); setTask(null); }}>Next</button></div> : null}
      {task && "input" in task ? <section><h3>{task.id}</h3><MarkdownCodeBlock language="json" content={JSON.stringify({ input: task.input, policyVisibleContext: task.policyVisibleContext, artifacts: task.artifacts }, null, 2)} /></section> : null}
    </> : <>
      {graders.length ? <DropdownSelect label="Grader" floating value={grader!.id} options={graders.map(item => ({ value: item.id, label: item.feedbackKey, description: `Version ${item.version}` }))} onChange={setGrader} /> : page.data ? <p>No graders attached.</p> : null}
      {definition.data ? <MarkdownCodeBlock language="json" content={JSON.stringify(definition.data, null, 2)} /> : null}
      {definition.isFetching ? <p role="status">Loading grader definition…</p> : null}
      {hostedEditor ? <a className="training-text-button" href={hostedEditor} target="_blank" rel="noreferrer">Open private grader editor and checks</a> : null}
    </>}
  </>;
}
