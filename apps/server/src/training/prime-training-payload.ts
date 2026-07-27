import type { createTrainingApi } from "./training-api.js";
import type { createPrimeGrpoModelRunService } from "./prime-grpo-model-run-service.js";

export function createPrimeTrainingPayload(deps: {
  primeGrpoModelRuns: ReturnType<typeof createPrimeGrpoModelRunService>;
  trainingApi: ReturnType<typeof createTrainingApi>;
}) {
return async (
  action: string,
  payload: unknown,
  requestUrl?: URL,
) => {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  const modelRunId =
    typeof record.modelRunId === "string"
      ? record.modelRunId
      : null;
  if (
    modelRunId
    && await deps.primeGrpoModelRuns.applies(modelRunId)
  ) {
    if (action === "prepare_model_run") {
      return deps.primeGrpoModelRuns.prepare({
        modelRunId,
        maximumSpendUsd:
          typeof record.maximumSpendUsd === "number"
            ? record.maximumSpendUsd
            : null,
        retentionDays:
          typeof record.retentionDays === "number"
            ? record.retentionDays
            : null,
      });
    }
    if (action === "start_model_run") {
      return deps.primeGrpoModelRuns.start({
        modelRunId,
        maximumSpendUsd:
          typeof record.maximumSpendUsd === "number"
            ? record.maximumSpendUsd
            : null,
        retentionDays:
          typeof record.retentionDays === "number"
            ? record.retentionDays
            : null,
        manifest: record.manifest,
      });
    }
    if (action === "model_run_status") {
      return deps.primeGrpoModelRuns.status(modelRunId);
    }
    if (action === "model_run_events") {
      return deps.primeGrpoModelRuns.events(modelRunId);
    }
    if (action === "model_run_logs") {
      return deps.primeGrpoModelRuns.logs(modelRunId);
    }
    if (action === "model_run_artifacts") {
      return deps.primeGrpoModelRuns.artifacts(modelRunId);
    }
    if (action === "cancel_model_run") {
      return deps.primeGrpoModelRuns.cancel(modelRunId);
    }
  }
  return deps.trainingApi.request(action, payload, requestUrl);
};


}

