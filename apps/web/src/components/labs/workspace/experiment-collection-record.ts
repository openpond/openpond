import type { LocalExperimentRecord } from "@openpond/contracts";
import type { ExperimentRunDetails, ExperimentGraderPin } from "openpond-sdk/experiments";
import type { WorkspaceApi } from "./workspace-api";

export type ExperimentCollectionRecord = {
  key: string; id: string; location: "local" | "hosted"; api: WorkspaceApi;
  request: ExperimentRunDetails["request"]; graders: ExperimentGraderPin[];
  maximumCostUsd: number; packageHash?: string; status: string;
  createdAt: string; startedAt: string | null; completedAt: string | null;
  completed: number; total: number; modelId: string; manifestHash: string;
  resultAvailable: boolean; error: string | null;
  raw: { location: "local"; value: LocalExperimentRecord } | { location: "hosted"; value: ExperimentRunDetails };
};
export function localExperimentRecord(api: WorkspaceApi, value: LocalExperimentRecord): ExperimentCollectionRecord {
  return { key: `local:${value.id}`, id: value.id, location: "local", api,
    request: value.configuration.request, graders: value.graders, maximumCostUsd: value.maximumCostUsd,
    packageHash: value.packageHash, status: value.status === "completed" && value.counts.failed ? "failed" : value.status,
    createdAt: value.createdAt, startedAt: value.createdAt, completedAt: value.completedAt,
    completed: value.counts.completed, total: Object.values(value.counts).reduce((sum, count) => sum + count, 0),
    modelId: value.model.modelId, manifestHash: value.executionHash,
    resultAvailable: Boolean(value.completedAt && value.cleanupComplete), error: value.error,
    raw: { location: "local", value } };
}
export function hostedExperimentRecord(api: WorkspaceApi, value: ExperimentRunDetails): ExperimentCollectionRecord {
  return { key: `hosted:${value.summary.id}`, id: value.summary.id, location: "hosted", api,
    request: value.request, graders: value.configuration.graders, maximumCostUsd: value.configuration.maximumCostUsd,
    status: value.summary.status === "completed" && value.summary.counts.failed ? "failed" : value.summary.status,
    createdAt: value.summary.createdAt, startedAt: value.summary.startedAt, completedAt: value.summary.completedAt,
    completed: value.summary.counts.completed, total: value.summary.totalCount,
    modelId: "modelId" in value.request.policy ? value.request.policy.modelId : "Fixtures",
    manifestHash: value.summary.manifestHash, resultAvailable: value.summary.resultAvailable,
    error: value.summary.error?.message ?? null, raw: { location: "hosted", value } };
}
