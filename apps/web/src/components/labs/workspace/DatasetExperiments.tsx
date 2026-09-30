import { useInfiniteQuery } from "@tanstack/react-query";
import type { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import type { ModelsRoute } from "../models-route";
import { EvaluationModel } from "./EvaluationPresentation";
import type { WorkspaceApi } from "./workspace-api";

type Page = Awaited<ReturnType<OpenPondExperimentsClient["list"]>>;

/** Dataset filtering belongs to the authorized host query before paging. */
export function DatasetExperiments({ api, releaseHash, route, navigate }: {
  api: WorkspaceApi; releaseHash: string | null; route: ModelsRoute; navigate: (route: ModelsRoute) => void;
}) {
  const query = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "datasetExperiments", releaseHash],
    enabled: Boolean(releaseHash), initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: Page) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => api.request<Page>("datasetExperiments", {
      datasetHash: releaseHash, ...(pageParam ? { afterId: pageParam } : {}),
    }, signal),
  });
  const items = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  if (!releaseHash) return <p>Publish this Dataset to view its Experiment associations.</p>;
  return <>{query.error ? <p role="alert">{query.error.message} <button onClick={() => void query.refetch()}>Retry</button></p> : null}
    <table className="training-data-table evaluation-workspace-table"><thead><tr><th>Experiment</th><th>Target</th><th>Setup revision</th></tr></thead><tbody>
      {items.map(item => {
        const destination = { ...route, page: "experiments" as const, resourceId: item.id, datasetKind: undefined, executionId: null, passId: null, detailTab: "overview" };
        return <tr key={item.id}><td><button className="training-text-button" onClick={() => navigate(destination)}>{item.request.name}</button></td><td><EvaluationModel name={"modelId" in item.request.policy ? item.request.policy.modelId : "Authored fixtures"} onOpen={() => navigate({ ...destination, detailTab: "configuration" })} /></td><td>{item.revision}</td></tr>;
      })}
      {query.isPending ? <tr><td colSpan={3} role="status">Loading associated Experiments…</td></tr> : !items.length ? <tr><td colSpan={3}>No Experiments use this Dataset release in the selected Project.</td></tr> : null}
    </tbody></table>
    {query.hasNextPage ? <button className="training-button secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>More associated Experiments</button> : null}
  </>;
}
