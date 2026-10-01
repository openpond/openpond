import { ScheduledAdmissionRejectedError } from "./evaluation-schedule-admission-guard.js";
import { contentHash } from "@openpond/harness";
import {
  nextNightlyOccurrence,
  coalesceNightlyOccurrences,
} from "@openpond/evals/learning";
import {
  ExperimentEvaluationScheduleInputSchema,
  ExperimentEvaluationScheduleControlSchema,
  sealExperimentEvaluationSchedule,
  scheduledExperimentHash,
  type ExperimentEvaluationSchedule,
} from "openpond-sdk/experiment-evaluation-schedules";
import { createExperimentEvaluationScheduleStore } from "./experiment-evaluation-schedule-store.js";
import type { createLocalScheduledExperimentRuntime } from "./experiment-evaluation-schedule-runtime.js";
const terminal = new Set(["completed", "failed", "cancelled"]);
function nextAt(cadence: ExperimentEvaluationSchedule["cadence"], now: string) {
  return cadence.kind === "nightly"
    ? nextNightlyOccurrence(cadence.calendar, now)
    : new Date(Date.parse(now) + cadence.seconds * 1000).toISOString();
}
function seal(
  value: ExperimentEvaluationSchedule,
  patch: Partial<ExperimentEvaluationSchedule>,
) {
  const { contentHash: _hash, ...body } = value;
  void _hash;
  return sealExperimentEvaluationSchedule({
    ...body,
    ...patch,
    revision: value.revision + 1,
    updatedAt: new Date().toISOString(),
  });
}
/** Explicit policy publication is separate from source sync and on-open reads.
 * The persisted occurrence precedes all paid I/O; unknown admissions only read
 * their deterministic Run and cannot restart compute after response loss. */
export function createExperimentEvaluationScheduleService(deps: {
  storeDir: string;
  identity(): Promise<{ actorId: string; teamId: string }>;
  authorize(
    configuration: ExperimentEvaluationSchedule["configuration"],
  ): Promise<void>;
  runtime: ReturnType<typeof createLocalScheduledExperimentRuntime>;
  latestRelease?: (
    configuration: ExperimentEvaluationSchedule["configuration"],
  ) => Promise<ExperimentEvaluationSchedule["newerUnevaluatedRelease"]>;
}) {
  const store = createExperimentEvaluationScheduleStore(deps.storeDir);
  let active: Promise<void> | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    closing = false;
  async function owner(teamId: string) {
    const actor = await deps.identity();
    if (actor.teamId !== teamId)
      throw new Error("Scheduled evaluation workspace changed.");
    return actor;
  }
  async function fence(actor: { actorId: string; teamId: string }) {
    if (contentHash(await deps.identity()) !== contentHash(actor))
      throw new Error("Scheduled evaluation account changed.");
  }
  async function publish(raw: unknown) {
    const input = ExperimentEvaluationScheduleInputSchema.parse(raw),
      actor = await owner(input.teamId);
    if (input.enabled) await deps.authorize(input.configuration);
    await fence(actor);
    const id =
        input.id ??
        `evaluation-schedule-${contentHash([actor, input.operationId]).slice(0, 40)}`,
      hash = contentHash(input),
      now = new Date().toISOString();
    return store.operation(
      actor.actorId,
      actor.teamId,
      input.operationId,
      hash,
      () => {
        const previous = store.read(id, actor.actorId, actor.teamId);
        if ((previous?.revision ?? 0) !== input.expectedRevision)
          throw new Error("Schedule changed; reload its exact revision.");
        const configurationHash = scheduledExperimentHash(input.configuration);
        if (
          previous?.fires.some((fire) => !terminal.has(fire.state)) &&
          configurationHash !== previous.configurationHash
        )
          throw new Error(
            "Clean the retained occurrence before changing its reviewed recipe.",
          );
        const held = (previous?.fires ?? []).reduce(
          (sum, fire) => sum + (fire.actualSpendUsd ?? fire.maximumCostUsd),
          0,
        );
        if (input.maximumTotalSpendUsd < held)
          throw new Error(
            "The approved ceiling is below retained spend or unsettled reservations.",
          );
        return sealExperimentEvaluationSchedule({
          schemaVersion: "openpond.experimentEvaluationSchedule.v1",
          id,
          revision: (previous?.revision ?? 0) + 1,
          ...actor,
          projectId: input.projectId,
          operationId: input.operationId,
          requestHash: hash,
          configuration: input.configuration,
          configurationHash,
          cadence: input.cadence,
          state: input.enabled ? "scheduled" : "disabled",
          nextRunAt: input.enabled
            ? previous?.nextRunAt &&
              contentHash(previous.cadence) === contentHash(input.cadence)
              ? previous.nextRunAt
              : nextAt(input.cadence, now)
            : null,
          maximumTotalSpendUsd: input.maximumTotalSpendUsd,
          maximumAttempts: input.maximumAttempts,
          lastEvaluatedConfigurationHash:
            previous?.lastEvaluatedConfigurationHash ?? null,
          newerUnevaluatedRelease: previous?.newerUnevaluatedRelease ?? null,
          fires: previous?.fires ?? [],
          reason: null,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
      },
    );
  }
  async function read(teamId: string, id: string) {
    const actor = await owner(teamId),
      value = store.read(id, actor.actorId, actor.teamId);
    if (!value)
      throw new Error("Schedule is unavailable to the current owner.");
    await fence(actor);
    return value;
  }
  async function list(teamId: string, afterId = "", limit = 50) {
    const actor = await owner(teamId),
      items = store.list(actor.actorId, teamId, afterId, limit);
    await fence(actor);
    return {
      items,
      nextCursor: items.length === limit ? items.at(-1)!.id : null,
    };
  }
  async function control(raw: unknown) {
    const input = ExperimentEvaluationScheduleControlSchema.parse(raw),
      actor = await owner(input.teamId),
      current = await read(input.teamId, input.id);
    if (input.action === "retry_active")
      await deps.authorize(current.configuration);
    await fence(actor);
    return store.operation(
      actor.actorId,
      actor.teamId,
      input.operationId,
      contentHash(input),
      () => {
        const value = store.read(input.id, actor.actorId, actor.teamId);
        if (!value || value.revision !== input.expectedRevision)
          throw new Error("Schedule changed; reload its revision.");
        const fire = value.fires.at(-1);
        if (input.action === "pause")
          return seal(value, { state: "disabled", nextRunAt: null });
        if (!fire) throw new Error("No occurrence is available.");
        if (input.action === "cancel_active") {
          if (terminal.has(fire.state)) return seal(value, {});
          return seal(value, {
            fires: value.fires.map((item) =>
              item.id !== fire.id
                ? item
                : {
                    ...item,
                    state: item.state === "reserved" ? "cancelled" : "cleaning",
                    cleanupComplete: item.state === "reserved",
                    actualSpendUsd:
                      item.state === "reserved" ? 0 : item.actualSpendUsd,
                    error: "Owner requested cancellation.",
                  },
            ),
          });
        }
        if (
          !terminal.has(fire.state) ||
          !fire.cleanupComplete ||
          fire.actualSpendUsd === null
        )
          throw new Error(
            "Settle actual cleanup and accounting before another explicit attempt.",
          );
        if (fire.state === "completed")
          throw new Error(
            "A completed pinned recipe does not require a retry.",
          );
        return seal(value, {
          state: "scheduled",
          nextRunAt: new Date().toISOString(),
          lastEvaluatedConfigurationHash: null,
          reason: null,
        });
      },
    );
  }
  const activeClaims=new Map<string,string>();
  async function run(id: string, actor: { actorId: string; teamId: string }) {
    const claim = store.claim(id, actor.actorId, actor.teamId);
    if (!claim) return;
    activeClaims.set(id,claim.token);
    let value = claim.value;
    let leaseLost = false;
    const renewal = setInterval(() => {
      try {
        if (!store.renew(id, claim.token)) leaseLost = true;
      } catch {
        leaseLost = true;
      }
    }, 15000);
    renewal.unref();
    const save = (patch: Partial<ExperimentEvaluationSchedule>) => {
      if (leaseLost || closing)
        throw new Error(
          "The scheduled owner lease was lost; only actual Run recovery is allowed.",
        );
      value = store.advance(seal(value, patch), claim.token);
    };
    try {
      await fence(actor);
      let fire = value.fires.at(-1);
      if (fire && !terminal.has(fire.state)) {
        if (fire.state === "cleaning") await deps.runtime.cancel(value, fire);
        if (fire.state === "reserved") {
          // Actual canonical admission repeats source/model/Project qualification.
          // Its insertion guard owns cancellation throughout that awaited work.
          save({
            fires: value.fires.map((item) =>
              item.id === fire!.id ? { ...item, state: "dispatching" } : item,
            ),
          });
          fire = value.fires.at(-1)!;
          try {
            const retainedGuard=store.admissionGuard(value,claim.token,fire.operationId);
            const executionId = await deps.runtime.dispatch(value, fire,{...retainedGuard,assertExecution(id){if(closing)throw new Error("The scheduled owner is stopping; no new provider requests are admitted.");retainedGuard.assertExecution(id);}});
            await fence(actor);
            save({
              fires: value.fires.map((item) =>
                item.id === fire!.id
                  ? { ...item, executionId, state: "running" }
                  : item,
              ),
            });
            fire = value.fires.at(-1)!;
          } catch (error) {
            if(error instanceof ScheduledAdmissionRejectedError) {
              value=store.retainRejectedAdmission(value,claim.token,error);
              return;
            }
            save({
              state: "blocked",
              reason:
                "The retained admission is uncertain; recover its actual Run before retrying.",
              fires: value.fires.map((item) =>
                item.id === fire!.id
                  ? {
                      ...item,
                      state: "uncertain",
                      error: (error instanceof Error
                        ? error.message
                        : String(error)
                      ).slice(0, 4000),
                    }
                  : item,
              ),
            });
            return;
          }
        }
        const observed = await deps.runtime.observe(value, fire);
        await fence(actor);
        const settled = observed.settled && observed.spendUsd !== null;
        const terminalUnsettled=!settled&&["completed","failed","cancelled","interrupted"].includes(observed.state);
        save({
          ...(terminalUnsettled?{state:"blocked" as const,reason:observed.cleanupComplete?"The actual Run stopped and cleaned up; its original provider accounting remains uncertain.":"The actual Run stopped; cleanup and original provider accounting still need confirmation."}:{}),
          lastEvaluatedConfigurationHash:
            settled && observed.state === "completed"
              ? fire.configurationHash
              : value.lastEvaluatedConfigurationHash,
          fires: value.fires.map((item) =>
            item.id === fire!.id
              ? {
                  ...item,
                  executionId: observed.id,
                  state: settled
                    ? observed.state === "completed"
                      ? "completed"
                      : observed.state === "cancelled"
                        ? "cancelled"
                        : "failed"
                    : terminalUnsettled
                      ? "uncertain"
                    : item.state === "cleaning"
                      ? "cleaning"
                      : "running",
                  cleanupComplete: observed.cleanupComplete,
                  actualSpendUsd: settled ? observed.spendUsd : null,
                  error: terminalUnsettled?observed.reason??"The original Run cannot admit another occurrence until actual accounting and cleanup settle.":observed.reason,
                }
              : item,
          ),
        });
        return;
      }
      if (deps.latestRelease && value.state === "scheduled") {
        const latest = await deps.latestRelease(value.configuration);
        await fence(actor);
        if (contentHash(latest) !== contentHash(value.newerUnevaluatedRelease))
          save({ newerUnevaluatedRelease: latest });
      }
      const now = new Date().toISOString();
      if (
        value.state !== "scheduled" ||
        !value.nextRunAt ||
        value.nextRunAt > now
      )
        return;
      const occurrence =
        value.cadence.kind === "nightly"
          ? coalesceNightlyOccurrences(
              value.cadence.calendar,
              value.nextRunAt,
              now,
            )
          : (() => {
              const interval = value.cadence.seconds * 1000,
                due = Date.parse(value.nextRunAt!);
              const count = Math.floor((Date.parse(now) - due) / interval);
              return {
                coalescedCount: count,
                coalescedThroughAt: new Date(
                  due + count * interval,
                ).toISOString(),
                nextRunAt: new Date(due + (count + 1) * interval).toISOString(),
              };
            })();
      const attempts = value.fires.filter(
          (item) => item.configurationHash === value.configurationHash,
        ).length,
        spent = value.fires.reduce(
          (sum, item) => sum + (item.actualSpendUsd ?? item.maximumCostUsd),
          0,
        ),
        remaining = value.maximumTotalSpendUsd - spent;
      if (
        attempts >= value.maximumAttempts ||
        remaining < value.configuration.maximumCostUsd ||
        value.fires.length >= 10000
      ) {
        save({
          state: "blocked",
          reason:
            "The reviewed attempt or cumulative spend ceiling is exhausted.",
        });
        return;
      }
      await deps.authorize(value.configuration);
      await fence(actor);
      const operationId = `scheduled-experiment-${contentHash([value.id, value.configurationHash, value.nextRunAt, attempts + 1]).slice(0, 48)}`;
      save({
        nextRunAt: occurrence.nextRunAt,
        reason: null,
        fires: [
          ...value.fires,
          {
            id: operationId,
            operationId,
            scheduledAt: value.nextRunAt,
            coalescedThroughAt: occurrence.coalescedThroughAt,
            coalescedCount: occurrence.coalescedCount,
            configurationHash: value.configurationHash,
            state: "reserved",
            executionId: null,
            attempt: attempts + 1,
            maximumCostUsd: value.configuration.maximumCostUsd,
            actualSpendUsd: null,
            cleanupComplete: false,
            error: null,
          },
        ],
      });
    } catch (error) {
      try {
        save({
          state: "blocked",
          reason: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 4000),
        });
      } catch {
        /* A newer owner/control revision remains authoritative. */
      }
    } finally {
      clearInterval(renewal);
      activeClaims.delete(id);
      store.release(id, claim.token);
    }
  }
  async function runDue() {
    if (active) return active;
    active = (async () => {
      const actor = await deps.identity();
      let cursor = "";
      do {
        const items = store.list(actor.actorId, actor.teamId, cursor, 100);
        for (const item of items) {
          if (closing) return;
          await run(item.id, actor);
        }
        if (items.length < 100) break;
        cursor = items.at(-1)!.id;
      } while (true);
    })().finally(() => {
      active = null;
    });
    return active;
  }
  return {
    publish,
    read,
    list,
    control,
    runDue,
    start() {
      if (timer || closing) return;
      const tick = () => {
        timer = null;
        void runDue()
          .catch(() => undefined)
          .finally(() => {
            if (!closing) {
              timer = setTimeout(tick, 15000);
              timer.unref();
            }
          });
      };
      timer = setTimeout(tick, 15000);
      timer.unref();
    },
    async stop() {
      closing = true;
      for(const [id,token] of activeClaims)store.release(id,token);
      if (timer) clearTimeout(timer);
      timer = null;
      await active;
    },
    async close() {
      closing = true;
      for(const [id,token] of activeClaims)store.release(id,token);
      if(timer)clearTimeout(timer);
      timer=null;
      await active;
      store.close();
    },
  };
}
