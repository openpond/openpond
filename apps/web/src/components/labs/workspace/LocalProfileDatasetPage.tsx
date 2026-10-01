import { DatasetExperiments } from "./DatasetExperiments";
import { useQuery } from "@tanstack/react-query";
import { LocalExperimentSourceChoicesSchema } from "@openpond/contracts";
import { DatasetPopulationPageSchema } from "openpond-sdk/dataset-workspaces";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
import { DatasetTaskCheckbox, DatasetTaskSelection } from "./DatasetTaskSelection";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspaceActions, useWorkspaceResourceName } from "./WorkspacePanel";
import { EvaluationTableState } from "./EvaluationTableState";

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
    source
      ? [
          {
            id: "experiment",
            label: "Experiment",
            onSelect: () => setup.openSelection(source.taskset, route),
          },
        ]
      : [],
  );
  useWorkspaceResourceName(source?.name ?? null);
  const release = page.data?.release;
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
        Released on this computer · {release?.id} · Revision {release?.revision}
      </p>
      <nav className="evaluation-workspace-tabs" aria-label="Dataset sections">
        {["tasks", "experiments"].map((tab) => (
          <button
            key={tab}
            aria-selected={(route.detailTab ?? "tasks") === tab}
            onClick={() => navigate({ ...route, detailTab: tab, after: null })}
          >
            {tab === "tasks" ? "Tasks" : "Experiments"}
          </button>
        ))}
      </nav>
      <div hidden={route.detailTab === "experiments"}>
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
              <tr key={task.id}>
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
      {route.detailTab === "experiments" ? (
        <DatasetExperiments
          api={api}
          releaseHash={release?.contentHash ?? source?.taskset.contentHash ?? null}
          route={route}
          navigate={navigate}
        />
      ) : null}
    </>
  );
}
