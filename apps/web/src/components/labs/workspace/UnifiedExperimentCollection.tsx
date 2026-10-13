import type { z } from "zod";
import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LocalExperimentRecordPageSchema } from "@openpond/contracts";
import type { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import { localRequest } from "./local-workspace-api";
import { workspaceApiForLocation, type WorkspaceApi } from "./workspace-api";
import { ExperimentCollectionTable } from "./ExperimentCollectionTable";
import { hostedExperimentRecord, localExperimentRecord } from "./experiment-collection-record";
import type { ModelsRoute } from "../models-route";

type HostedPage = Awaited<ReturnType<OpenPondExperimentsClient["list"]>>;
type LocalExperimentRecordPage = z.infer<typeof LocalExperimentRecordPageSchema>;
export function UnifiedExperimentCollection({ api, route, navigate, datasetHash, datasetId }: {
  api: WorkspaceApi; route: ModelsRoute; navigate: (route: ModelsRoute) => void; datasetHash?: string; datasetId?: string;
}) {
  const localApi = useMemo(() => workspaceApiForLocation(api, "local"), [api]);
  const hostedApi = useMemo(() => workspaceApiForLocation(api, "hosted"), [api]);
  const local = useInfiniteQuery({ queryKey: ["unified-experiments", localApi.key, datasetHash, route.query],
    initialPageParam: undefined as string | undefined, getNextPageParam: (page: LocalExperimentRecordPage) => page.nextCursor ?? undefined,
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(item => ["queued", "running", "cancelling"].includes(item.status))) ? 2000 : false,
    queryFn: ({ signal, pageParam }) => localRequest(localApi, LocalExperimentRecordPageSchema, "list", {
      limit: 30, ...(api.projectId ? { projectId: api.projectId } : {}), ...(datasetHash ? { datasetHash } : {}),
      ...(route.query ? { search: route.query } : {}), ...(pageParam ? { afterId: pageParam } : {}),
    }, signal),
  });
  const hosted = useInfiniteQuery({ queryKey: ["unified-experiments", hostedApi.key, datasetHash, route.query],
    initialPageParam: undefined as string | undefined, getNextPageParam: (page: HostedPage) => page.nextCursor ?? undefined,
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(item => ["queued", "running", "cancelling"].includes(item.summary.status))) ? 2000 : false,
    queryFn: ({ signal, pageParam }) => hostedApi.request<HostedPage>("experiments", { limit: 30,
      ...(datasetHash ? { datasetHash } : {}), ...(route.query ? { search: route.query } : {}), ...(pageParam ? { afterId: pageParam } : {}),
    }, signal),
  });
  const rows = [...new Map([
    ...(local.data?.pages.flatMap(page => page.items) ?? []).map(item => localExperimentRecord(localApi, item)),
    ...(hosted.data?.pages.flatMap(page => page.items) ?? []).map(item => hostedExperimentRecord(hostedApi, item)),
  ].map(row => [row.key, row])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key));
  const visible = datasetId ? rows.filter(row => row.request.taskset.id === datasetId || row.request.taskset.id.startsWith(`taskset-release-${datasetId}-r`)) : rows;
  useEffect(() => {
    if (!datasetId) return;
    if (local.hasNextPage && !local.isFetchingNextPage && !local.isFetchNextPageError) void local.fetchNextPage();
    if (hosted.hasNextPage && !hosted.isFetchingNextPage && !hosted.isFetchNextPageError) void hosted.fetchNextPage();
  }, [datasetId, local.hasNextPage, local.isFetchingNextPage, local.fetchNextPage, local.isFetchNextPageError, hosted.hasNextPage, hosted.isFetchingNextPage, hosted.fetchNextPage, hosted.isFetchNextPageError]);
  return <>
    {local.error ? <p role="alert">Desktop experiments: {local.error.message} <button className="training-text-button" onClick={() => void local.refetch()}>Retry</button></p> : null}
    {hosted.error ? <p role="alert">Hosted experiments: {hosted.error.message} <button className="training-text-button" onClick={() => void hosted.refetch()}>Retry</button></p> : null}
    <ExperimentCollectionTable rows={visible} loading={!visible.length && (local.isPending || hosted.isPending || Boolean(datasetId && ((local.hasNextPage && !local.isFetchNextPageError) || (hosted.hasNextPage && !hosted.isFetchNextPageError))))} route={route} navigate={navigate} />
    {local.hasNextPage ? <button className="training-button secondary evaluation-more" disabled={local.isFetchingNextPage} onClick={() => void local.fetchNextPage()}>More Desktop experiments</button> : null}
    {hosted.hasNextPage ? <button className="training-button secondary evaluation-more" disabled={hosted.isFetchingNextPage} onClick={() => void hosted.fetchNextPage()}>More Hosted experiments</button> : null}
  </>;
}
