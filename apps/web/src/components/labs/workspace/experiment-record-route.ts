import type { ExperimentCollectionRecord } from "./experiment-collection-record";
import { modelsLocation, type ModelsRoute } from "../models-route";

export function experimentRecordRoute(
  row: ExperimentCollectionRecord,
  route: ModelsRoute,
  detailTab = "tasks",
): ModelsRoute {
  if (row.kind === "draft")
    return modelsLocation("experiments", null, {
      area: route.area,
      projectId: row.record.projectId,
      collection: "drafts",
      resourceId: row.id,
      executionLocation: row.location,
    });
  if (row.kind === "training")
    return modelsLocation("runs", null, {
      area: route.area,
      projectId: row.api.projectId,
      resourceId: `hosted-run:${row.id}`,
      detailTab: detailTab === "tasks" ? "details" : detailTab,
    });
  return {
    ...route,
    page: "experiments",
    executionLocation: row.location,
    resourceId:
      row.kind === "modification"
        ? `modification-recording:${row.id}`
        : row.kind === "managed-modification"
          ? `${row.execution.method === "decision_model" ? "managed-decision" : row.execution.method === "alphaedit" ? "managed-alphaedit" : row.execution.method === "selective_neuron_training" ? "managed-neuron-training" : row.execution.method === "weight_space_programming" ? "managed-weight-space" : row.execution.method === "engram_adapter" ? "managed-engram" : "managed-modification"}:${row.id}`
          : row.id,
    projectId: row.kind === "managed-modification" ? row.execution.projectId : route.projectId,
    detailTab:
      row.kind === "modification" || row.kind === "managed-modification" ? null : detailTab,
    collection: "default",
    datasetKind: undefined,
    revision: undefined,
    contentHash: undefined,
    executionId: null,
    passId: null,
    after: null,
  };
}
