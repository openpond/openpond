import { parseAndVerifyTrainingEstimate, parseAndVerifyTrainingGpuCatalog,
  parseAndVerifyTrainingFunding, parseAndVerifyTrainingFundingHandoff,
  type TrainingFundingRequest, type TrainingFundingHandoffRequest,
  type TrainingEstimateRequest, type TrainingGpuCatalogQuery } from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";

/** Desktop and hosted panels share their existing authenticated setup owner. */
export async function readTrainingCompute(api: WorkspaceApi, query: TrainingGpuCatalogQuery, signal?: AbortSignal) {
  return parseAndVerifyTrainingGpuCatalog(await setupRead(api, "gpu-catalog", query, signal), query);
}

export async function readTrainingEstimate(api: WorkspaceApi, request: TrainingEstimateRequest, signal?: AbortSignal) {
  return parseAndVerifyTrainingEstimate(await setupRead(api, "estimate", request, signal), request);
}

export async function readTrainingFunding(api: WorkspaceApi, request: TrainingFundingRequest, signal?: AbortSignal) {
  return parseAndVerifyTrainingFunding(await setupRead(api, "funding", request, signal), request, api.actorId ?? undefined);
}

export async function createTrainingFundingHandoff(api: WorkspaceApi, request: TrainingFundingHandoffRequest) {
  return parseAndVerifyTrainingFundingHandoff(await setupRead(api, "funding-handoff", request), request, api.actorId ?? undefined);
}

function setupRead(api: WorkspaceApi, action: string, value: unknown, signal?: AbortSignal) {
  return apiFetch(api.connection, `/v1/training/setup/${action}?teamId=${encodeURIComponent(api.teamId)}`, {
    method: "POST", body: JSON.stringify(value), signal,
  });
}
