import { LocalExperimentCollection } from "./LocalExperimentCollection";
import { HostedExperimentCollection } from "./HostedExperimentCollection";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import type { ModelsRoute } from "../models-route";
import type { WorkspaceApi } from "./workspace-api";

type Page = Awaited<ReturnType<OpenPondExperimentsClient["list"]>>;

/** Dataset filtering belongs to the authorized host query before paging. */
export function DatasetExperiments({
  api,
  releaseHash,
  route,
  navigate,
}: {
  api: WorkspaceApi;
  releaseHash: string | null;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
}) {
  const query = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "datasetExperiments", releaseHash],
    enabled: Boolean(releaseHash) && api.location !== "local",
    initialPageParam: undefined as string | undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((item) =>
          ["queued", "running", "cancelling"].includes(item.summary.status),
        ),
      )
        ? 2000
        : false,
    getNextPageParam: (page: Page) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) =>
      api.request<Page>(
        "datasetExperiments",
        {
          datasetHash: releaseHash,
          ...(pageParam ? { afterId: pageParam } : {}),
        },
        signal,
      ),
  });
  const items = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [
        item.summary.id,
        item,
      ]),
    ).values(),
  ];
  if (!releaseHash) return <p>Publish this Dataset to view its Experiment associations.</p>;
  if (api.location === "local")
    return (
      <LocalExperimentCollection
        key={`${api.key}:${releaseHash}`}
        api={api}
        route={route}
        navigate={navigate}
        datasetHash={releaseHash}
      />
    );
  return (
    <>
      <HostedExperimentCollection
        api={api}
        key={`${api.key}:${releaseHash}`}
        items={items}
        loading={query.isPending}
        error={query.error?.message}
        retry={() => void query.refetch()}
        route={route}
        navigate={navigate}
      />
      {query.hasNextPage ? (
        <button
          className="training-button secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          More Experiments
        </button>
      ) : null}
    </>
  );
}
