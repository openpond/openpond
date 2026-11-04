import { useManagedAlphaEditClient } from "./managed-alphaedit-api";
import { useManagedNeuronTrainingClient } from "./managed-neuron-training-api";
import { useManagedDecisionClient } from "./managed-decision-api";
import { useManagedEngramClient } from "./managed-engram-api";
import {
  TrainingExecutionPageSchema,
  type TrainingExecutionPage,
  type ExperimentDraftPage,
  type ManagedModificationExecutionPage,
} from "openpond-sdk/training";
import { ErrorToast } from "../../common/ErrorToast";
import type { z } from "zod";
import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LocalExperimentRecordPageSchema } from "@openpond/contracts";
import type { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import { localRequest } from "./local-workspace-api";
import { workspaceApiForLocation, type WorkspaceApi } from "./workspace-api";
import { experimentDraftApi } from "./experiment-draft-api";
import { modificationRecordingApi } from "./modification-recording-api";
import { useManagedModificationClient } from "./managed-modification-api";
import { ExperimentCollectionTable } from "./ExperimentCollectionTable";
import {
  managedModificationExperimentRecord,
  draftExperimentRecord,
  hostedExperimentRecord,
  localExperimentRecord,
  modificationExperimentRecord,
  trainingExperimentRecord,
} from "./experiment-collection-record";
import type { ModelsRoute } from "../models-route";

type HostedPage = Awaited<ReturnType<OpenPondExperimentsClient["list"]>>;
type LocalExperimentRecordPage = z.infer<typeof LocalExperimentRecordPageSchema>;
export function UnifiedExperimentCollection({
  api,
  route,
  navigate,
  datasetHash,
  datasetId,
}: {
  api: WorkspaceApi;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
  datasetHash?: string;
  datasetId?: string;
}) {
  const localApi = useMemo(() => workspaceApiForLocation(api, "local"), [api]);
  const hostedApi = useMemo(() => workspaceApiForLocation(api, "hosted"), [api]);
  const local = useInfiniteQuery({
    queryKey: ["unified-experiments", localApi.key, datasetHash, route.query],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: LocalExperimentRecordPage) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((item) => ["queued", "running", "cancelling"].includes(item.status)),
      )
        ? 2000
        : false,
    queryFn: ({ signal, pageParam }) =>
      localRequest(
        localApi,
        LocalExperimentRecordPageSchema,
        "list",
        {
          limit: 30,
          ...(api.projectId ? { projectId: api.projectId } : {}),
          ...(datasetHash ? { datasetHash } : {}),
          ...(route.query ? { search: route.query } : {}),
          ...(pageParam ? { afterId: pageParam } : {}),
        },
        signal,
      ),
  });
  const hosted = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, datasetHash, route.query],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: HostedPage) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((item) =>
          ["queued", "running", "cancelling"].includes(item.summary.status),
        ),
      )
        ? 2000
        : false,
    queryFn: ({ signal, pageParam }) =>
      hostedApi.request<HostedPage>(
        "experiments",
        {
          limit: 30,
          ...(datasetHash ? { datasetHash } : {}),
          ...(route.query ? { search: route.query } : {}),
          ...(pageParam ? { afterId: pageParam } : {}),
        },
        signal,
      ),
  });
  const training = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, "training", datasetHash, route.query],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: TrainingExecutionPage) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some(
          (item) =>
            !["succeeded", "failed", "cancelled", "budget_exhausted"].includes(item.job.state),
        ),
      )
        ? 2000
        : false,
    queryFn: async ({ signal, pageParam }) =>
      TrainingExecutionPageSchema.parse(
        await hostedApi.request(
          "trainingExecutions",
          {
            limit: 30,
            ...(datasetHash ? { datasetHash } : {}),
            ...(route.query ? { search: route.query } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
          signal,
        ),
      ),
  });
  const drafts = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, "drafts", route.query],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ExperimentDraftPage) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) =>
      experimentDraftApi(hostedApi, signal).list({
        ...(route.query ? { search: route.query } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
  });
  const observations = useInfiniteQuery({
    queryKey: [
      "unified-experiments",
      localApi.key,
      localApi.actorId,
      "modification-recordings",
      route.query,
    ],
    enabled: !datasetHash && !datasetId && Boolean(localApi.actorId),
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (
      page: Awaited<ReturnType<ReturnType<typeof modificationRecordingApi>["list"]>>,
    ) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) =>
      modificationRecordingApi(localApi, signal).list({
        ...(route.query ? { search: route.query } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
  });
  const modificationClient = useManagedModificationClient(hostedApi, !datasetHash && !datasetId);
  const modifications = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, hostedApi.actorId, "managed-modifications"],
    enabled: !datasetHash && !datasetId && Boolean(modificationClient.data),
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ManagedModificationExecutionPage) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => {
      if (!modificationClient.data) throw new Error("Load the execution account first.");
      return modificationClient.data.list(
        { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
    },
    refetchInterval: (query) =>
      query.state.error
        ? false
        : query.state.data?.pages.some((page) =>
              page.items.some(
                (row) => !["prepared", "completed", "cancelled", "failed"].includes(row.phase),
              ),
            )
          ? 3000
          : false,
  });
  const decisionClient = useManagedDecisionClient(hostedApi, !datasetHash && !datasetId);
  const decisions = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, hostedApi.actorId, "managed-decisions"],
    enabled: !datasetHash && !datasetId && Boolean(decisionClient.data),
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: import("openpond-sdk/training").ManagedDecisionExecutionPage) =>
      page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => {
      if (!decisionClient.data) throw new Error("Load the execution account first.");
      return decisionClient.data.list(
        { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
    },
    refetchInterval: (query) =>
      query.state.error
        ? false
        : query.state.data?.pages.some((page) =>
              page.items.some(
                (row) => !["prepared", "completed", "cancelled", "failed"].includes(row.phase),
              ),
            )
          ? 3000
          : false,
  });
  const engramClient = useManagedEngramClient(hostedApi, !datasetHash && !datasetId);
  const engrams = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, hostedApi.actorId, "managed-engrams"],
    enabled: !datasetHash && !datasetId && Boolean(engramClient.data),
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: import("openpond-sdk/training").ManagedEngramExecutionPage) =>
      page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => {
      if (!engramClient.data) throw new Error("Load the execution account first.");
      return engramClient.data.list(
        { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
    },
    refetchInterval: (query) =>
      query.state.error
        ? false
        : query.state.data?.pages.some((page) =>
              page.items.some(
                (row) => !["prepared", "completed", "cancelled", "failed"].includes(row.phase),
              ),
            )
          ? 3000
          : false,
  });
  const alphaEditsClient = useManagedAlphaEditClient(hostedApi, !datasetHash && !datasetId);
  const alphaEdits = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, hostedApi.actorId, "managed-alphaedit"],
    enabled: !datasetHash && !datasetId && Boolean(alphaEditsClient.data),
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: import("openpond-sdk/training").ManagedAlphaEditExecutionPage) =>
      page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => {
      if (!alphaEditsClient.data) throw new Error("Load the execution account first.");
      return alphaEditsClient.data.list(
        { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
    },
    refetchInterval: (query) =>
      query.state.error
        ? false
        : query.state.data?.pages.some((page) =>
              page.items.some(
                (row) => !["prepared", "completed", "cancelled", "failed"].includes(row.phase),
              ),
            )
          ? 3000
          : false,
  });
  const neuronTrainingsClient = useManagedNeuronTrainingClient(
    hostedApi,
    !datasetHash && !datasetId,
  );
  const neuronTrainings = useInfiniteQuery({
    queryKey: ["unified-experiments", hostedApi.key, hostedApi.actorId, "managed-neuron-training"],
    enabled: !datasetHash && !datasetId && Boolean(neuronTrainingsClient.data),
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: import("openpond-sdk/training").ManagedNeuronTrainingExecutionPage) =>
      page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) => {
      if (!neuronTrainingsClient.data) throw new Error("Load the execution account first.");
      return neuronTrainingsClient.data.list(
        { limit: 25, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
    },
    refetchInterval: (query) =>
      query.state.error
        ? false
        : query.state.data?.pages.some((page) =>
              page.items.some(
                (row) => !["prepared", "completed", "cancelled", "failed"].includes(row.phase),
              ),
            )
          ? 3000
          : false,
  });
  const rows = [
    ...new Map(
      [
        ...(
          alphaEdits.data?.pages
            .flatMap((page) => page.items)
            .filter(
              (item) =>
                !route.query ||
                `${item.name} ${item.model.modelId} ${item.id}`
                  .toLowerCase()
                  .includes(route.query.toLowerCase()),
            ) ?? []
        ).map((item) => managedModificationExperimentRecord(hostedApi, item)),
        ...(
          neuronTrainings.data?.pages
            .flatMap((page) => page.items)
            .filter(
              (item) =>
                !route.query ||
                `${item.name} ${item.model.modelId} ${item.id}`
                  .toLowerCase()
                  .includes(route.query.toLowerCase()),
            ) ?? []
        ).map((item) => managedModificationExperimentRecord(hostedApi, item)),
        ...(
          decisions.data?.pages
            .flatMap((page) => page.items)
            .filter(
              (item) =>
                !route.query ||
                `${item.name} ${item.model.source.modelId} ${item.id}`
                  .toLowerCase()
                  .includes(route.query.toLowerCase()),
            ) ?? []
        ).map((item) => managedModificationExperimentRecord(hostedApi, item)),
        ...(
          engrams.data?.pages
            .flatMap((page) => page.items)
            .filter(
              (item) =>
                !route.query ||
                `${item.name} ${item.model.modelId} ${item.id}`
                  .toLowerCase()
                  .includes(route.query.toLowerCase()),
            ) ?? []
        ).map((item) => managedModificationExperimentRecord(hostedApi, item)),
        ...(
          modifications.data?.pages
            .flatMap((page) => page.items)
            .filter(
              (item) =>
                !route.query ||
                `${item.name} ${item.model.modelId} ${item.id}`
                  .toLowerCase()
                  .includes(route.query.toLowerCase()),
            ) ?? []
        ).map((item) => managedModificationExperimentRecord(hostedApi, item)),
        ...(drafts.data?.pages.flatMap((page) => page.items) ?? []).map((item) =>
          draftExperimentRecord(hostedApi, item),
        ),
        ...(!datasetHash && !datasetId
          ? (observations.data?.pages.flatMap((page) => page.items) ?? [])
          : []
        ).map((item) => modificationExperimentRecord(localApi, item)),
        ...(local.data?.pages.flatMap((page) => page.items) ?? []).map((item) =>
          localExperimentRecord(localApi, item),
        ),
        ...(hosted.data?.pages.flatMap((page) => page.items) ?? []).map((item) =>
          hostedExperimentRecord(hostedApi, item),
        ),
        ...(training.data?.pages.flatMap((page) => page.items) ?? []).map((item) =>
          trainingExperimentRecord(hostedApi, item),
        ),
      ].map((row) => [row.key, row]),
    ).values(),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key));
  const matching = datasetHash
    ? rows.filter((row) => row.dataset?.contentHash === datasetHash)
    : rows;
  const visible = datasetId
    ? matching.filter(
        (row) =>
          row.dataset &&
          (row.dataset.id === datasetId ||
            row.dataset.id.startsWith(`taskset-release-${datasetId}-r`)),
      )
    : matching;
  useEffect(() => {
    if (!datasetId && !datasetHash) return;
    if (drafts.hasNextPage && !drafts.isFetchingNextPage && !drafts.isFetchNextPageError)
      void drafts.fetchNextPage();
    if (local.hasNextPage && !local.isFetchingNextPage && !local.isFetchNextPageError)
      void local.fetchNextPage();
    if (hosted.hasNextPage && !hosted.isFetchingNextPage && !hosted.isFetchNextPageError)
      void hosted.fetchNextPage();
    if (training.hasNextPage && !training.isFetchingNextPage && !training.isFetchNextPageError)
      void training.fetchNextPage();
  }, [
    datasetId,
    datasetHash,
    drafts.hasNextPage,
    drafts.isFetchingNextPage,
    drafts.isFetchNextPageError,
    drafts.fetchNextPage,
    local.hasNextPage,
    local.isFetchingNextPage,
    local.fetchNextPage,
    local.isFetchNextPageError,
    hosted.hasNextPage,
    hosted.isFetchingNextPage,
    hosted.fetchNextPage,
    hosted.isFetchNextPageError,
    training.hasNextPage,
    training.isFetchingNextPage,
    training.fetchNextPage,
    training.isFetchNextPageError,
  ]);
  return (
    <>
      {local.error ? (
        <ErrorToast error={local.error} prefix="Desktop experiments">
          <button className="training-text-button" onClick={() => void local.refetch()}>
            Retry
          </button>
        </ErrorToast>
      ) : null}
      {hosted.error ? (
        <ErrorToast error={hosted.error} prefix="Hosted experiments">
          <button className="training-text-button" onClick={() => void hosted.refetch()}>
            Retry
          </button>
        </ErrorToast>
      ) : null}
      {training.error ? (
        <ErrorToast error={training.error} prefix="Training experiments">
          <button className="training-text-button" onClick={() => void training.refetch()}>
            Retry training history
          </button>
        </ErrorToast>
      ) : null}
      {drafts.error ? (
        <ErrorToast error={drafts.error} prefix="Experiment drafts">
          <button className="training-text-button" onClick={() => void drafts.refetch()}>
            Retry drafts
          </button>
        </ErrorToast>
      ) : null}
      <ErrorToast error={alphaEdits.error ?? alphaEditsClient.error} prefix="AlphaEdit experiments">
        <button
          className="training-text-button"
          onClick={() => {
            void alphaEditsClient.refetch();
            void alphaEdits.refetch();
          }}
        >
          Retry AlphaEdit history
        </button>
      </ErrorToast>
      <ErrorToast
        error={neuronTrainings.error ?? neuronTrainingsClient.error}
        prefix="Neuron training experiments"
      >
        <button
          className="training-text-button"
          onClick={() => {
            void neuronTrainingsClient.refetch();
            void neuronTrainings.refetch();
          }}
        >
          Retry neuron training history
        </button>
      </ErrorToast>
      <ErrorToast error={decisions.error ?? decisionClient.error} prefix="Decision experiments">
        <button
          className="training-text-button"
          onClick={() => {
            void decisionClient.refetch();
            void decisions.refetch();
          }}
        >
          Retry Decision history
        </button>
      </ErrorToast>
      <ErrorToast error={engrams.error ?? engramClient.error} prefix="Engram experiments">
        <button
          className="training-text-button"
          onClick={() => {
            void engramClient.refetch();
            void engrams.refetch();
          }}
        >
          Retry Engram history
        </button>
      </ErrorToast>
      <ErrorToast
        error={modifications.error ?? modificationClient.error}
        prefix="Hosted activation experiments"
      >
        <button
          className="training-text-button"
          onClick={() => {
            void modificationClient.refetch();
            void modifications.refetch();
          }}
        >
          Retry activation history
        </button>
      </ErrorToast>
      <ErrorToast error={observations.error} prefix="Local observations">
        <button className="training-text-button" onClick={() => void observations.refetch()}>
          Retry observations
        </button>
      </ErrorToast>
      <ExperimentCollectionTable
        rows={visible}
        loading={
          !visible.length &&
          (local.isPending ||
            hosted.isPending ||
            training.isPending ||
            drafts.isPending ||
            observations.isLoading ||
            modifications.isLoading ||
            alphaEdits.isLoading ||
            neuronTrainings.isLoading ||
            engrams.isLoading ||
            decisions.isLoading ||
            Boolean(
              (datasetId || datasetHash) &&
              ((drafts.hasNextPage && !drafts.isFetchNextPageError) ||
                (local.hasNextPage && !local.isFetchNextPageError) ||
                (hosted.hasNextPage && !hosted.isFetchNextPageError) ||
                (training.hasNextPage && !training.isFetchNextPageError)),
            ))
        }
        route={route}
        navigate={navigate}
      />
      {alphaEdits.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={alphaEdits.isFetchingNextPage}
          onClick={() => void alphaEdits.fetchNextPage()}
        >
          More AlphaEdit experiments
        </button>
      ) : null}
      {neuronTrainings.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={neuronTrainings.isFetchingNextPage}
          onClick={() => void neuronTrainings.fetchNextPage()}
        >
          More neuron training experiments
        </button>
      ) : null}
      {decisions.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={decisions.isFetchingNextPage}
          onClick={() => void decisions.fetchNextPage()}
        >
          More Decision experiments
        </button>
      ) : null}
      {engrams.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={engrams.isFetchingNextPage}
          onClick={() => void engrams.fetchNextPage()}
        >
          More Engram experiments
        </button>
      ) : null}
      {modifications.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={modifications.isFetchingNextPage}
          onClick={() => void modifications.fetchNextPage()}
        >
          More hosted activation experiments
        </button>
      ) : null}
      {!datasetHash && !datasetId && observations.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={observations.isFetchingNextPage}
          onClick={() => void observations.fetchNextPage()}
        >
          More observations
        </button>
      ) : null}
      {drafts.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={drafts.isFetchingNextPage}
          onClick={() => void drafts.fetchNextPage()}
        >
          More experiment drafts
        </button>
      ) : null}
      {local.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={local.isFetchingNextPage}
          onClick={() => void local.fetchNextPage()}
        >
          More Desktop experiments
        </button>
      ) : null}
      {hosted.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={hosted.isFetchingNextPage}
          onClick={() => void hosted.fetchNextPage()}
        >
          More Hosted experiments
        </button>
      ) : null}
      {training.hasNextPage ? (
        <button
          className="training-button secondary evaluation-more"
          disabled={training.isFetchingNextPage}
          onClick={() => void training.fetchNextPage()}
        >
          More training experiments
        </button>
      ) : null}
    </>
  );
}
