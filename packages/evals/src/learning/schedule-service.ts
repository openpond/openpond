import { contentHash } from "@openpond/harness";
import { assertLearningContentHash, learningRef, sameLearningRef, type LearningPolicy } from "./contracts.js";
import { LearningScheduleSchema } from "./schedule-contracts.js";
import { LearningDomainError } from "./errors.js";
import { requireLearningRelease, requireLearningResource, type LearningTransaction } from "./repository.js";
import { nextNightlyOccurrence } from "./nightly-schedule.js";

export function learningScheduleId(policyId: string) { return `schedule-${contentHash(policyId)}`; }

/** Called atomically with policy publication. No external timer or Work is made. */
export async function synchronizeLearningSchedule(tx: LearningTransaction, policy: LearningPolicy, now: string) {
  assertLearningContentHash(policy);
  const current = await requireLearningResource(tx, "policy", policy.id);
  if (!sameLearningRef(learningRef(current), learningRef(policy))) throw new LearningDomainError("learning_policy_revision_stale", 409);
  const id = learningScheduleId(policy.id);
  const previous = await tx.get("schedule", id);
  if (previous && sameLearningRef(previous.policy, learningRef(policy))) return previous;
  const intervalSeconds = policy.trigger.kind === "schedule" ? policy.trigger.intervalSeconds : policy.trigger.kind === "approved_count" ? 60 : null;
  const calendar = policy.trigger.kind === "nightly" ? { localTime: policy.trigger.localTime, timeZone: policy.trigger.timeZone } : null;
  const enabled = policy.enabled && policy.automation.train && (intervalSeconds !== null || calendar !== null);
  const previousPolicy = previous ? await requireLearningRelease(tx, "policy", previous.policy) : null;
  const preserveDue = previous?.nextRunAt && previous.intervalSeconds === intervalSeconds
    && JSON.stringify(previous.calendar) === JSON.stringify(calendar) && previousPolicy?.trigger.kind === policy.trigger.kind
    && previous.executionOwner === policy.executionOwner;
  const schedule = LearningScheduleSchema.parse({
    schemaVersion: "openpond.learningSchedule.v1", id, revision: (previous?.revision ?? 0) + 1,
    policy: learningRef(policy), modelProjectId: policy.modelProjectId, executionOwner: policy.executionOwner,
    state: enabled ? "scheduled" : "disabled", intervalSeconds, calendar,
    nextRunAt: enabled ? preserveDue ? previous.nextRunAt : calendar ? nextNightlyOccurrence(calendar, now) : new Date(Date.parse(now) + intervalSeconds! * 1_000).toISOString() : null,
    lastFire: previous?.lastFire ?? null, consecutiveFailures: 0, nextAttemptAt: null, lastError: null,
    createdAt: previous?.createdAt ?? now, updatedAt: now,
  });
  await tx.put("schedule", schedule, previous?.revision ?? 0, { parentId: policy.modelProjectId, status: schedule.state });
  return schedule;
}
