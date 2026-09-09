import { z } from "zod";
import type { SqliteStore } from "../store/store.js";
import type { createTrainingService } from "./training-service.js";
import { trainingRunDetail } from "./run-detail.js";

type RunReadAction = "job_events" | "run_detail" | "managed_evaluation_tasks";

export function isTrainingRunReadAction(
  action: string,
): action is RunReadAction {
  return (
    action === "job_events" ||
    action === "run_detail" ||
    action === "managed_evaluation_tasks"
  );
}

export async function handleTrainingRunRead(input: {
  action: RunReadAction;
  payload: Record<string, unknown>;
  store: SqliteStore;
  training: Pick<
    ReturnType<typeof createTrainingService>,
    "refreshManagedRunEvidence" | "managedEvaluationTasks"
  >;
}) {
  const jobId = z.string().trim().min(1).max(191).parse(input.payload.jobId);
  if (input.action === "job_events")
    return input.store.listTrainingJobEvents(jobId);
  if (input.action === "managed_evaluation_tasks") {
    const evaluationId = z
      .string()
      .trim()
      .min(1)
      .max(191)
      .parse(input.payload.evaluationId);
    return input.training.managedEvaluationTasks(jobId, evaluationId, {
      cursor: z.string().optional().parse(input.payload.cursor),
      limit: z.number().optional().parse(input.payload.limit),
    });
  }
  await input.training.refreshManagedRunEvidence(jobId);
  return trainingRunDetail(input.store, jobId, {
    includeEvaluation: input.payload.includeEvaluation !== false,
  });
}
