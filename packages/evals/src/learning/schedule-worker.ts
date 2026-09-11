import { contentHash } from "@openpond/harness";
import { learningRef, sealLearningContent } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { reserveLearningIteration } from "./iteration-reservation-service.js";
import { LearningScheduleFireSchema, LearningScheduleSchema, type LearningSchedule, type LearningScheduleFire } from "./schedule-contracts.js";
import { requireLearningRelease, requireLearningResource, type LearningRepository } from "./repository.js";
import { inspectIterationEligibility } from "./iteration-eligibility.js";
import { coalesceNightlyOccurrences } from "./nightly-schedule.js";

const skipReasons = new Map<string, NonNullable<LearningScheduleFire["reason"]>>([
  ["learning_iteration_active", "active_iteration"], ["learning_iteration_cooldown", "cooldown"],
  ["learning_daily_budget_exhausted", "daily_budget"],
]);

/** Like a durable scheduled Work fire, the occurrence and timer advance commit
 * together. Here the typed target is a learning reservation, never a prompt or
 * provider submission. All work inside the transaction is repository-only. */
export function createLearningScheduleWorker(repository: LearningRepository, options: {
  executionOwner: "local" | "hosted"; now?: () => string;
}) {
  const now = options.now ?? (() => new Date().toISOString());

  async function run(scope: string, scheduleId: string, actorId: string): Promise<LearningSchedule> {
    let attempt: { schedule: LearningSchedule; maxRetries: number } | null = null;
    try {
      return await repository.transaction(scope, async tx => {
        const schedule = await requireLearningResource(tx, "schedule", scheduleId);
        if (schedule.executionOwner !== options.executionOwner) throw new LearningDomainError("learning_execution_owner_mismatch", 409);
        const timestamp = now();
        const time = Date.parse(timestamp);
        if (schedule.state !== "scheduled" || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > time
          || (schedule.nextAttemptAt && Date.parse(schedule.nextAttemptAt) > time)) return schedule;
        attempt = { schedule, maxRetries: 0 };
        const policy = await requireLearningRelease(tx, "policy", schedule.policy);
        attempt.maxRetries = policy.limits.maxRetries;
        const matches = policy.trigger.kind === "nightly" ? schedule.intervalSeconds === null && schedule.calendar?.localTime === policy.trigger.localTime && schedule.calendar.timeZone === policy.trigger.timeZone
          : policy.trigger.kind === "schedule" ? schedule.calendar === null && policy.trigger.intervalSeconds === schedule.intervalSeconds
          : policy.trigger.kind === "approved_count" && schedule.calendar === null && schedule.intervalSeconds === 60;
        if (policy.executionOwner !== schedule.executionOwner || !matches) throw new LearningDomainError("learning_schedule_policy_mismatch", 409);
        const scheduledAt = schedule.nextRunAt;
        const interval = (schedule.intervalSeconds ?? 86_400) * 1_000;
        const due = Date.parse(scheduledAt);
        const coalescedCount = Math.floor((time - due) / interval);
        const occurrence = schedule.calendar ? coalesceNightlyOccurrences(schedule.calendar, scheduledAt, timestamp) : {
          coalescedCount, coalescedThroughAt: new Date(due + coalescedCount * interval).toISOString(), nextRunAt: new Date(due + (coalescedCount + 1) * interval).toISOString(),
        };
        // Below-threshold count checks advance their timer without filling the
        // Model's history with empty iterations or consuming any evidence.
        if (policy.trigger.kind === "approved_count" && (await inspectIterationEligibility(tx, policy)).counts.eligible < policy.admission.minimumApprovedExamples) {
          const updated = LearningScheduleSchema.parse({ ...schedule, revision: schedule.revision + 1, nextRunAt: occurrence.nextRunAt,
            consecutiveFailures: 0, nextAttemptAt: null, lastError: null, updatedAt: timestamp });
          await tx.put("schedule", updated, schedule.revision, { parentId: schedule.modelProjectId, status: updated.state });
          return updated;
        }
        const id = `schedule-fire-${contentHash([schedule.id, scheduledAt])}`;
        let outcome: LearningScheduleFire["outcome"] = "skipped";
        let reason: LearningScheduleFire["reason"] = null;
        let iteration: LearningScheduleFire["iteration"] = null;
        try {
          const pointers = await reserveLearningIteration(tx, { action: "reserve_iteration", operationId: id,
            policy: schedule.policy, trigger: policy.trigger.kind === "approved_count" ? { kind: "approved_count", checkedAt: scheduledAt } : { kind: "schedule", scheduledAt } }, actorId, timestamp);
          const pointer = pointers.find(value => value.kind === "iteration");
          if (!pointer) throw new LearningDomainError("learning_schedule_reservation_missing", 409);
          const reservation = await requireLearningResource(tx, "reservation", pointer.id);
          outcome = reservation.outcome;
          iteration = { id: pointer.id, revision: pointer.revision };
        } catch (error) {
          // These admission checks run before reservation mutations. Every other
          // error must roll back the whole fire, including any partial batch.
          const skip = error instanceof LearningDomainError ? skipReasons.get(error.code) : undefined;
          if (!skip) throw error;
          reason = skip;
        }
        const fire = LearningScheduleFireSchema.parse(sealLearningContent({
          schemaVersion: "openpond.learningScheduleFire.v1", id, revision: 1, scheduleId,
          policy: schedule.policy, scheduledAt, coalescedThroughAt: occurrence.coalescedThroughAt,
          coalescedCount: occurrence.coalescedCount, outcome, reason, iteration, createdAt: timestamp,
        }));
        await tx.put("schedule_fire", fire, 0, { parentId: schedule.id, status: outcome });
        const updated = LearningScheduleSchema.parse({ ...schedule, revision: schedule.revision + 1,
          nextRunAt: occurrence.nextRunAt, lastFire: learningRef(fire),
          consecutiveFailures: 0, nextAttemptAt: null, lastError: null, updatedAt: timestamp });
        await tx.put("schedule", updated, schedule.revision, { parentId: schedule.modelProjectId, status: updated.state });
        return updated;
      });
    } catch (error) {
      // Failed transactions keep the original due time and exact fire identity.
      // A concurrent policy edit owns its new timer; never overwrite that state.
      const failed = attempt as { schedule: LearningSchedule; maxRetries: number } | null;
      if (!failed) throw error;
      return repository.transaction(scope, async tx => {
        const current = await requireLearningResource(tx, "schedule", scheduleId);
        if (current.revision !== failed.schedule.revision) return current;
        const timestamp = now();
        const consecutiveFailures = current.consecutiveFailures + 1;
        const blocked = consecutiveFailures > failed.maxRetries;
        const updated = LearningScheduleSchema.parse({ ...current, revision: current.revision + 1,
          state: blocked ? "blocked" : "scheduled", consecutiveFailures,
          nextAttemptAt: blocked ? null : new Date(Date.parse(timestamp) + Math.min(60_000, 1_000 * 2 ** Math.min(consecutiveFailures - 1, 10))).toISOString(),
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 20_000), updatedAt: timestamp });
        await tx.put("schedule", updated, current.revision, { parentId: current.modelProjectId, status: updated.state });
        return updated;
      });
    }
  }
  return { run };
}
