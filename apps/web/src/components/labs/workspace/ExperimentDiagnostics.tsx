import "../../../styles/labs/run-diagnostics.css";
import { useInfiniteQuery } from "@tanstack/react-query";
import { verifyRunDiagnostics } from "openpond-sdk/experiments";
import type { WorkspaceApi } from "./workspace-api";
import { RunDiagnosticsView } from "./RunDiagnosticsView";
export function ExperimentDiagnostics({
  api,
  id,
  manifestHash,
}: {
  api: WorkspaceApi;
  id: string;
  manifestHash: string;
}) {
  const query = useInfiniteQuery({
    queryKey: ["run-diagnostics", api.key, id, manifestHash],
    initialPageParam: {} as { afterSequence?: number; afterCallId?: string },
    queryFn: async ({ pageParam, signal }) =>
      verifyRunDiagnostics(
        await (api.location === "local"
          ? api.local("diagnostics", { id, ...pageParam }, signal)
          : api.request("diagnostics", { id, ...pageParam }, signal)),
        { teamId: api.teamId, runId: id, manifestHash, ...pageParam },
      ),
    getNextPageParam: (page, pages) =>
      pages.length >= 20 || (page.nextEventCursor === null && page.nextCallCursor === null)
        ? undefined
        : {
            afterSequence:
              page.nextEventCursor ?? pages.flatMap((page) => page.events).at(-1)?.sequence,
            afterCallId: page.nextCallCursor ?? pages.flatMap((page) => page.calls).at(-1)?.id,
          },
  });
  return (
    <RunDiagnosticsView
      pages={query.data?.pages ?? []}
      loading={query.isFetching}
      error={query.error?.message}
      more={query.hasNextPage}
      onMore={() => void query.fetchNextPage()}
      onRefresh={() => void query.refetch()}
      onAnalyze={(prompt) => {
        window.dispatchEvent(new CustomEvent("openpond:diagnostic-draft", { detail: { prompt } }));
      }}
    />
  );
}
