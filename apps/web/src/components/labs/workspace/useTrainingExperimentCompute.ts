import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrainingGpuCatalogQuerySchema, type TrainingGpuSelection, type TrainingPreparationReceipt,
  type TrainingExperimentSetupRequest } from "openpond-sdk/training";
import { readTrainingCompute, readTrainingEstimate } from "./training-compute-api";
import type { WorkspaceApi } from "./workspace-api";

export function useTrainingExperimentCompute(input: {
  api: WorkspaceApi; method: "sft" | "grpo"; enabled: boolean;
  baseModel: TrainingExperimentSetupRequest["baseModel"] | null;
  recipe: TrainingExperimentSetupRequest["settings"]["recipe"];
  selection: TrainingGpuSelection; receipt: TrainingPreparationReceipt | null;
}) {
  const { api, baseModel, selection, receipt } = input;
  const [reviewInvalidatedAt, invalidateReview] = useState(0);
  const rank = input.recipe?.lora && typeof input.recipe.lora === "object" && "rank" in input.recipe.lora
    ? input.recipe.lora.rank : undefined;
  const parsed = TrainingGpuCatalogQuerySchema.safeParse({ teamId: api.teamId,
    modelId: baseModel?.modelId, modelRevision: baseModel?.revision, tokenizerRevision: baseModel?.tokenizerRevision,
    chatTemplateHash: baseModel?.chatTemplateHash, method: input.method, loraRank: rank, gpuCount: selection.gpuCount ?? 1 });
  const query = parsed.success ? parsed.data : null;
  const catalog = useQuery({
    queryKey: ["experiment-compute", api.accountKey, api.actorId, api.connection.serverUrl, api.projectId, query],
    enabled: input.enabled && query !== null && receipt === null,
    queryFn: ({ signal }) => {
      if (!query) throw new Error("Choose a pinned model and valid LoRA rank before loading compute.");
      return readTrainingCompute(api, query, signal);
    },
    retry: false, staleTime: 0,
  });
  const estimateRequest = receipt?.state === "prepared" ? {
    schemaVersion: "openpond.trainingEstimateRequest.v1" as const, teamId: api.teamId,
    source: { kind: "preparation" as const, id: receipt.plan.id, planHash: receipt.plan.contentHash, expectedRevision: receipt.revision },
    ...(receipt.plan.request.gpuSelection ? { gpuSelection: receipt.plan.request.gpuSelection } : {}),
  } : null;
  const estimate = useQuery({
    queryKey: ["experiment-estimate", api.accountKey, api.actorId, api.connection.serverUrl, api.projectId, estimateRequest],
    enabled: input.enabled && estimateRequest !== null,
    queryFn: ({ signal }) => {
      if (!estimateRequest) throw new Error("Review the experiment before requesting an estimate.");
      return readTrainingEstimate(api, estimateRequest, signal);
    },
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const catalogExpired = useExpired(catalog.data?.expiresAt);
  const estimateExpiresAt = estimate.data
    ? new Date(Math.min(Date.parse(estimate.data.expiresAt),
      estimate.data.pricing.quoteExpiresAt ? Date.parse(estimate.data.pricing.quoteExpiresAt) : Infinity)).toISOString() : undefined;
  const estimateExpired = useExpired(estimateExpiresAt);
  function reviewedEstimate() {
    const value = estimate.data;
    if (!estimateRequest || !value || estimate.isFetching || estimate.isError || estimate.dataUpdatedAt <= reviewInvalidatedAt || !estimateExpiresAt || Date.parse(estimateExpiresAt) <= Date.now())
      throw new Error("Refresh and review the current estimate before starting training.");
    if (!value.gpu.resolved || !["available", "limited"].includes(value.gpu.availability))
      throw new Error("Refresh compute availability before starting this experiment.");
    return value.review;
  }
  return { catalog, query, catalogExpired, estimate, estimateExpired, reviewedEstimate,
    requireFreshReview: () => invalidateReview(Date.now()),
    canStart: Boolean(estimateRequest && estimate.data?.gpu.resolved &&
      ["available", "limited"].includes(estimate.data.gpu.availability) && estimate.dataUpdatedAt > reviewInvalidatedAt && !estimateExpired && !estimate.isFetching && !estimate.isError) };
}

/** One timer at the authority boundary, rather than a render every second. */
export function useExpired(expiresAt?: string) {
  const [, expire] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => expire(value => value + 1), Math.min(remaining + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return Boolean(expiresAt && Date.parse(expiresAt) <= Date.now());
}
