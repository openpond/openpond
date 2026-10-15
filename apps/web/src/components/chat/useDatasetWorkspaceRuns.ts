import { useEffect } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatResourceSummary, RuntimeEvent } from "@openpond/contracts";
import { chatResourceRequest } from "../../api/chat-resource-api";
import type { ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import {
  activeRun,
  resourceIdentity,
  sameDataset,
  workspaceSummaries,
} from "./dataset-workspace-data";

type RunPage = {
  summaries: ChatResourceSummary[];
  items?: { id: string; createdAt: string }[];
  nextCursor?: string | null;
};
export function useDatasetWorkspaceRuns(
  connection: ClientConnection | null,
  dataset: ChatResourceSummary | null,
  linked: ChatResourceSummary[],
  events: RuntimeEvent[],
) {
  const account = connectionQueryScope(connection),
    queries = useQueryClient();
  const key = ["dataset-workspace-runs", account, dataset ? resourceIdentity(dataset) : null];
  const history = useInfiniteQuery({
    queryKey: key,
    enabled: Boolean(connection && dataset && !dataset.owner && !dataset.profileRef),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: RunPage) => page.nextCursor ?? undefined,
    queryFn: async ({ signal, pageParam }) => {
      const page = await chatResourceRequest<RunPage>(
        connection!,
        "experiment",
        { action: "list", payload: { limit: 100, ...(pageParam ? { afterId: pageParam } : {}) } },
        signal,
      );
      if (pageParam && page.nextCursor === pageParam)
        throw new Error("Experiment history did not advance to its next page.");
      return { ...page, summaries: workspaceSummaries(page.summaries) };
    },
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.summaries.some((run) => dataset && sameDataset(run, dataset) && activeRun(run.state)),
      )
        ? 2000
        : 10_000,
  });
  useEffect(() => {
    if (history.hasNextPage && !history.isFetchingNextPage && !history.isFetchNextPageError)
      void history.fetchNextPage();
  }, [
    history.hasNextPage,
    history.isFetchingNextPage,
    history.isFetchNextPageError,
    history.fetchNextPage,
  ]);
  const version = events
    .filter((event) => ["workspace_action_result", "turn.completed"].includes(event.name))
    .at(-1)?.id;
  useEffect(() => {
    if (version) void queries.invalidateQueries({ queryKey: ["dataset-workspace-runs", account] });
  }, [version, account, queries]);
  const times = new Map(
    history.data?.pages.flatMap(
      (page) => page.items?.map((item) => [item.id, Date.parse(item.createdAt)] as const) ?? [],
    ) ?? [],
  );
  const rows = dataset
    ? [
        ...new Map(
          [...linked, ...(history.data?.pages.flatMap((page) => page.summaries) ?? [])]
            .filter((run) => sameDataset(run, dataset))
            .map((run) => [resourceIdentity(run), run]),
        ).values(),
      ].sort(
        (a, b) =>
          Number(activeRun(b.state)) - Number(activeRun(a.state)) ||
          (times.get(b.id) ?? 0) - (times.get(a.id) ?? 0),
      )
    : [];
  return { rows, history };
}
