import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import {
  TrainingExperimentInputsPageSchema,
  type TrainingExperimentInputsPage,
  type TrainingExperimentSetupRequest,
} from "openpond-sdk/training";
import { assertLearningContentHash, learningRef, sameLearningRef } from "openpond-sdk/learning";
import { apiFetch } from "../../../api/api-client";
import { learningQueryScope } from "../../../lib/query-scope";
import { useWorkspaceLearningClient } from "./useWorkspaceLearningClient";
import type { WorkspaceApi } from "./workspace-api";

export function useTrainingExperimentInputs(
  api: WorkspaceApi,
  enabled: boolean,
  selected?: TrainingExperimentSetupRequest["batch"] | null,
  additionalSelected: readonly (TrainingExperimentSetupRequest["batch"] | null)[] = [],
) {
  const learning = useWorkspaceLearningClient(api);
  const query = useInfiniteQuery({
    queryKey: [
      "training-experiment-inputs",
      api.accountKey,
      api.actorId,
      api.connection.serverUrl,
      api.teamId,
      api.projectId,
    ],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: TrainingExperimentInputsPage) => page.nextCursor ?? undefined,
    queryFn: async ({ signal, pageParam }) => {
      const params = new URLSearchParams({ teamId: api.teamId });
      if (api.projectId) params.set("projectId", api.projectId);
      if (pageParam) params.set("cursor", pageParam);
      const page = TrainingExperimentInputsPageSchema.parse(
        await apiFetch(api.connection, `/v1/training/setup/draft-inputs?${params}`, { signal }),
      );
      if (
        page.teamId !== api.teamId ||
        page.actorId !== api.actorId ||
        page.projectId !== api.projectId ||
        (pageParam && page.nextCursor === pageParam)
      )
        throw new Error("Training inputs returned a different account, Project or cursor.");
      return page;
    },
  });
  const page = query.data?.pages[0];
  const listed = query.data?.pages.flatMap((page) => page.batches) ?? [];
  const missing = [
    ...new Map(
      [selected, ...additionalSelected]
        .filter((ref) => ref != null)
        .map((ref) => [ref.contentHash, ref]),
    ).values(),
  ].filter((ref) => !listed.some((item) => sameLearningRef(item.reference, ref)));
  const retained = useQueries({
    queries: missing.map((selected) => ({
      queryKey: [...learningQueryScope(learning), "experiment-selected-batch", selected],
      enabled,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const batch = await learning.get("batch", selected.id, selected.revision, { signal });
        assertLearningContentHash(batch);
        if (!sameLearningRef(learningRef(batch), selected))
          throw new Error("The selected reviewed batch differs from its saved release.");
        return {
          reference: learningRef(batch),
          rewardBinding: batch.rewardBinding,
          purpose: batch.purpose,
          exampleCount: batch.examples.length,
          sealedAt: batch.sealedAt,
        };
      },
      retry: false,
    })),
  });
  const batches = [
    ...new Map(
      [...listed, ...retained.flatMap((row) => (row.data ? [row.data] : []))].map((batch) => [
        batch.reference.contentHash,
        batch,
      ]),
    ).values(),
  ];
  return {
    ...query,
    models: page?.models ?? [],
    methods: page?.methods ?? [],
    billingModes: page?.billingModes,
    batches,
    error: query.error ?? retained.find((row) => row.error)?.error ?? null,
    isSuccess: query.isSuccess && retained.every((row) => row.isSuccess),
    isPending: query.isPending || retained.some((row) => row.isPending),
    refetch: async () => Promise.all([query.refetch(), ...retained.map((row) => row.refetch())]),
  };
}
