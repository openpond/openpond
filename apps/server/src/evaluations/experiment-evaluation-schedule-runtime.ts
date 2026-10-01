import { withScheduledAdmission,type ScheduledAdmissionGuard } from "./evaluation-schedule-admission-guard.js";
import { contentHash } from "@openpond/harness";
import { LocalExperimentRecordSchema } from "@openpond/contracts";
import {
  scheduledExperimentHash,
  type ExperimentEvaluationSchedule,
  type ExperimentEvaluationFire,
} from "openpond-sdk/experiment-evaluation-schedules";
import type { createLocalExperimentService } from "./local-experiment-service.js";
/** Actual canonical local admission is the only dispatch path. Restart replay
 * uses the same owner-scoped operation and never creates a substitute Run. */
export function createLocalScheduledExperimentRuntime(
  experiments: ReturnType<typeof createLocalExperimentService>,
) {
  const configuration = (
    schedule: ExperimentEvaluationSchedule,
    fire: ExperimentEvaluationFire,
  ) => ({
    ...schedule.configuration,
    operationId: fire.operationId,
    maximumCostUsd: fire.maximumCostUsd,
    request: {
      ...schedule.configuration.request,
      operationId: fire.operationId,
    },
  });
  async function admit(
    schedule: ExperimentEvaluationSchedule,
    fire: ExperimentEvaluationFire,
  ) {
    if (fire.configurationHash !== schedule.configurationHash)
      throw new Error(
        "The retained scheduled occurrence names a different recipe.",
      );
    return LocalExperimentRecordSchema.parse(
      await experiments.runFromRelease({
        configuration: configuration(schedule, fire),
      }),
    );
  }
  return {
    async dispatch(
      schedule: ExperimentEvaluationSchedule,
      fire: ExperimentEvaluationFire,
      guard:ScheduledAdmissionGuard,
    ) {
      const run = await withScheduledAdmission(guard,()=>admit(schedule, fire));
      if (
        run.ownerActorId !== schedule.actorId ||
        run.teamId !== schedule.teamId
      )
        throw new Error("Scheduled Run authority changed.");
      return run.id;
    },
    async observe(
      schedule: ExperimentEvaluationSchedule,
      fire: ExperimentEvaluationFire,
    ) {
      const id =
        fire.executionId ??
        `local-run-${contentHash([schedule.teamId, schedule.actorId, fire.operationId]).slice(0, 48)}`;
      const run = LocalExperimentRecordSchema.parse(
        await experiments.read({ teamId: schedule.teamId, id }),
      );
      if (
        run.ownerActorId !== schedule.actorId ||
        run.teamId !== schedule.teamId ||
        run.operationId !== fire.operationId ||
        contentHash(run.configuration.request.policy) !==
          contentHash(schedule.configuration.request.policy)
      )
        throw new Error(
          "The scheduled Run differs from its exact retained owner or target.",
        );
      const retained = run.configuration;
      if (
        scheduledExperimentHash({
          ...retained,
          maximumCostUsd: schedule.configuration.maximumCostUsd,
        }) !== schedule.configurationHash
      )
        throw new Error(
          "The scheduled Run changed its frozen population, graders or settings.",
        );
      const terminal = [
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(run.status);
      return {
        id: run.id,
        state: run.status,
        cleanupComplete: run.cleanupComplete,
        settled:
          terminal &&
          run.cleanupComplete &&
          run.usage.costUsd !== null &&
          run.usage.heldUsd === 0 &&
          run.usage.uncertainRequests === 0,
        spendUsd: run.usage.costUsd,
        reason: run.error,
      };
    },
    async cancel(
      schedule: ExperimentEvaluationSchedule,
      fire: ExperimentEvaluationFire,
    ) {
      const id =
        fire.executionId ??
        `local-run-${contentHash([schedule.teamId, schedule.actorId, fire.operationId]).slice(0, 48)}`;
      await experiments.cancel({ teamId: schedule.teamId, id });
    },
  };
}
