import type { ModelRun } from "@openpond/contracts";

import { evaluationModelRunStatus } from "./training-benchmark-state.js";

export type ModelRunControlAction =
  | "model_run_status"
  | "model_run_events"
  | "model_run_logs"
  | "model_run_artifacts"
  | "cancel_model_run"
  | "resume_model_run";

const MODEL_RUN_CONTROL_ACTIONS = new Set<string>([
  "model_run_status",
  "model_run_events",
  "model_run_logs",
  "model_run_artifacts",
  "cancel_model_run",
  "resume_model_run",
]);

export function isModelRunControlAction(action: string): action is ModelRunControlAction {
  return MODEL_RUN_CONTROL_ACTIONS.has(action);
}

export async function handleModelRunControl(input: {
  action: ModelRunControlAction;
  modelRunId: unknown;
  loadRun(id: string): Promise<ModelRun | null>;
  training: {
    modelRunStatus(id: string): Promise<unknown> | unknown;
    modelRunEvents(id: string): Promise<unknown> | unknown;
    modelRunLogs(id: string): Promise<unknown> | unknown;
    modelRunArtifacts(id: string): Promise<unknown> | unknown;
    cancelModelRun(id: string): Promise<unknown> | unknown;
  };
  harnessRefinerBenchmarks?: {
    cancel(id: string): Promise<unknown> | unknown;
    resume(id: string): Promise<unknown> | unknown;
  };
}) {
  const modelRunId = requiredString(input.modelRunId, "modelRunId");
  if (input.action === "model_run_events") return input.training.modelRunEvents(modelRunId);
  if (input.action === "model_run_logs") return input.training.modelRunLogs(modelRunId);
  if (input.action === "model_run_artifacts") return input.training.modelRunArtifacts(modelRunId);
  const run = await input.loadRun(modelRunId);
  if (input.action === "model_run_status") {
    return run?.kind === "evaluation"
      ? evaluationModelRunStatus(run)
      : input.training.modelRunStatus(modelRunId);
  }
  if (input.action === "cancel_model_run") {
    if (run?.kind !== "evaluation") return input.training.cancelModelRun(modelRunId);
    if (!input.harnessRefinerBenchmarks) {
      throw new Error("Harness Refiner benchmarks are unavailable.");
    }
    return input.harnessRefinerBenchmarks.cancel(modelRunId);
  }
  if (run?.kind !== "evaluation") {
    throw new Error("Only a checkpointed evaluation Model Run can resume.");
  }
  if (!input.harnessRefinerBenchmarks) {
    throw new Error("Harness Refiner benchmarks are unavailable.");
  }
  return input.harnessRefinerBenchmarks.resume(modelRunId);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
