import {DatasetAssignments} from "../../human-review/DatasetAssignments";
import { DatasetExperiments } from "./DatasetExperiments";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LocalExperimentSourceChoicesSchema } from "@openpond/contracts";
import { DatasetPopulationPageSchema, type DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
import { DatasetTaskCheckbox, DatasetTaskSelection, useDatasetTaskSelection } from "./DatasetTaskSelection";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { WorkspacePanel, useWorkspaceActions, useWorkspaceResourceName, useWorkspacePanelControls } from "./WorkspacePanel";
import { EvaluationTableState } from "./EvaluationTableState";
import { EvaluationCard } from "./EvaluationPresentation";
import { LocalProfileDatasetGraders, LocalProfileDatasetVersions } from "./LocalProfileDatasetEvidence";

/** Device-owned released Profile Dataset review uses the same selection state
 * and policy-only population contract; private package bytes stay in server. */
export function LocalProfileDatasetPage({
  api,
  route,
  navigate,
}: {
  api: WorkspaceApi;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
}) {
  const setup = useEvaluationSetup();
  const controls = useWorkspacePanelControls();
  const taskScope = JSON.stringify([api.key, route.resourceId, route.revision, route.contentHash]);
  const [inspection, setInspection] = useState<{
    scope: string;
    task: DatasetPopulationPage["items"][number];
  } | null>(null);
  const task = inspection?.scope === taskScope ? inspection.task : null;
  const choices = useQuery({
    queryKey: ["evaluation-workspace", api.key, "localSources"],
    queryFn: async ({ signal }) =>
      LocalExperimentSourceChoicesSchema.parse(await api.local("sourceChoices", {}, signal)),
  });
  const source = choices.data?.profiles.find((item) => item.id === route.resourceId);
  const page = useQuery({
    queryKey: [
      "evaluation-workspace",
      api.key,
      "localProfileDataset",
      route.resourceId,
      route.revision,
      route.contentHash,
      route.after,
    ],
    queryFn: async ({ signal }) =>
      DatasetPopulationPageSchema.parse(
        await api.local(
          "sourceDataset",
          {
            id: route.resourceId,
            view: "policy",
            limit: 30,
            ...(route.after ? { afterId: route.after } : {}),
          },
          signal,
        ),
      ),
  });
  const select = useWorkspaceActions(
    [
      ...(source ? [
          {
            id: "experiment",
            label: "Experiment",
            onSelect: () => setup.openSelection(source.taskset, route),
          },
        ] : []),
      ...(task ? [{ id: "task", label: "Task", onSelect: () => {} }] : []),
    ],
  );
  useWorkspaceResourceName(source?.name ?? null);
  const release = page.data?.release;
  useDatasetTaskSelection(release ?? null);
  const tab = route.detailTab ?? "tasks";
  function inspectTask(value: DatasetPopulationPage["items"][number]) {
    setInspection({ scope: taskScope, task: value });
    controls?.select({ id: "task", label: "Task", onSelect: () => {} });
  }
  if (
    release &&
    ((route.contentHash && route.contentHash !== release.contentHash) ||
      (route.revision && route.revision !== release.revision))
  )
    return <p role="alert">The local Dataset differs from the requested immutable version.</p>;
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1 className="sr-only">{source?.name ?? "Local Dataset"}</h1>
        <button className="training-button" disabled={!source} onClick={() => select("experiment")}>
          + Experiment
        </button>
      </header>
      <p>
        Released on this computer, {release?.id}, Revision {release?.revision}
      </p>
      {tab==="tasks"&&release?<DatasetAssignments api={api} release={release} route={route} navigate={navigate} localSourceId={route.resourceId??undefined}/>:null}
      <nav className="evaluation-workspace-tabs" aria-label="Dataset sections">
        {["tasks", "experiments", "graders", "versions"].map((value) => (
          <button
            key={value}
            aria-selected={tab === value}
            onClick={() => navigate({ ...route, detailTab: value, after: null })}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>
      <div hidden={tab !== "tasks"}>
        <table className="training-data-table evaluation-workspace-table">
          <thead>
            <tr>
              <th>
                {release ? (
                  <DatasetTaskSelection
                    release={release}
                    count={page.data!.taskCount}
                    route={route}
                  />
                ) : null}
              </th>
              <th>Task</th>
              <th>Input</th>
              <th>Split</th>
            </tr>
          </thead>
          <tbody>
            {page.data?.items.map((task) => (
              <tr key={task.id} tabIndex={0} onClick={() => inspectTask(task)}
                onKeyDown={(event) => { if (event.key === "Enter") inspectTask(task); }}>
                <DatasetTaskCheckbox release={release!} id={task.id} route={route} />
                <td>{task.id}</td>
                <td>{"input" in task ? JSON.stringify(task.input) : ""}</td>
                <td>{task.split}</td>
              </tr>
            ))}
            <EvaluationTableState
              columns={4}
              loading={page.isPending || choices.isPending}
              error={page.error?.message ?? choices.error?.message}
              empty={!page.data?.items.length}
              retry={() => void page.refetch()}
            >
              No policy-visible tasks in this released Dataset.
            </EvaluationTableState>
          </tbody>
        </table>
        {route.after ? (
          <button onClick={() => navigate({ ...route, after: null })}>First task page</button>
        ) : null}
        {page.data?.nextCursor ? (
          <button onClick={() => navigate({ ...route, after: page.data!.nextCursor })}>
            More tasks
          </button>
        ) : null}
      </div>
      {tab === "experiments" ? (
        <DatasetExperiments
          api={api}
          releaseHash={release?.contentHash ?? source?.taskset.contentHash ?? null}
          route={route}
          navigate={navigate}
        />
      ) : null}
      {tab === "graders" ? <LocalProfileDatasetGraders population={page.data}
        loading={page.isPending} error={page.error?.message} retry={() => void page.refetch()} /> : null}
      {tab === "versions" ? <LocalProfileDatasetVersions source={source}
        sources={choices.data?.profiles ?? []} population={page.data} route={route} navigate={navigate}
        loading={choices.isPending || page.isPending} error={choices.error?.message ?? page.error?.message}
        retry={() => { void choices.refetch(); void page.refetch(); }} /> : null}
      {task && "input" in task ? <WorkspacePanel action="task" label="Task inspector" onRequestClose={() => setInspection(null)}>
        <header><h2>{task.id}</h2></header>
        <EvaluationCard title="Input"><pre>{JSON.stringify(task.input, null, 2)}</pre></EvaluationCard>
        {"policyVisibleContext" in task ? <EvaluationCard title="Policy context"><pre>{JSON.stringify(task.policyVisibleContext, null, 2)}</pre></EvaluationCard> : null}
        {"artifacts" in task ? <EvaluationCard title="Policy artifacts"><pre>{JSON.stringify(task.artifacts, null, 2)}</pre></EvaluationCard> : null}
      </WorkspacePanel> : null}
    </>
  );
}
