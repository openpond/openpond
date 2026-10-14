import {
  OpenPondTrainingApiError,
  assertTrainingQualificationReceipt,
  type TrainingJob,
  type createTrainingClient,
} from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";

type Client = ReturnType<typeof createTrainingClient>;
type Options = Record<string, string | boolean>;
const terminal = new Set<TrainingJob["state"]>(["succeeded", "failed", "cancelled"]);

export type HostedWatchOptions = {
  intervalMs: number;
  deadlineAt: number | null;
  cancelAt: number | null;
  waitForCleanup: boolean;
  cleanupTimeoutMs: number;
  cancelOnInfrastructureError: boolean;
};

export function parseHostedWatchOptions(options: Options): HostedWatchOptions {
  const intervalMs = parseIntegerOption(options.intervalMs, "interval-ms") ?? 10_000;
  const cleanupTimeoutMs = parseIntegerOption(options.cleanupTimeoutMs, "cleanup-timeout-ms") ?? 180_000;
  const cleanupReserveMs = parseIntegerOption(options.cleanupReserveMs, "cleanup-reserve-ms") ?? 180_000;
  if ([intervalMs, cleanupTimeoutMs, cleanupReserveMs].some(value => !Number.isSafeInteger(value) || value > 2_147_483_647))
    throw new Error("Watch intervals and cleanup bounds must fit a positive 32-bit millisecond timer.");
  if (intervalMs < 250) throw new Error("--interval-ms must be at least 250.");
  if (cleanupTimeoutMs < 1_000 || cleanupReserveMs < 1_000)
    throw new Error("Cleanup timeout and reserve must be at least 1000 ms.");
  const value = optionString(options, "deadlineAt");
  if (!value && options.cleanupReserveMs !== undefined)
    throw new Error("--cleanup-reserve-ms requires --deadline-at.");
  const deadlineAt = value ? Date.parse(value) : null;
  if (value && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(deadlineAt)))
    throw new Error("--deadline-at requires an ISO timestamp with an explicit timezone.");
  if (deadlineAt !== null && deadlineAt - cleanupReserveMs <= Date.now())
    throw new Error("--deadline-at must leave time for execution and the cleanup reserve.");
  return {
    intervalMs, deadlineAt,
    cancelAt: deadlineAt === null ? null : deadlineAt - cleanupReserveMs,
    waitForCleanup: deadlineAt !== null || parseBooleanOption(options.waitForCleanup) || parseBooleanOption(options.cancelOnInfrastructureError),
    cleanupTimeoutMs,
    cancelOnInfrastructureError: parseBooleanOption(options.cancelOnInfrastructureError),
  };
}

/** Cancellation alone is safely reconciled after CAS races. Paid submission
 * commands never enter this retry path. Unknown POST outcomes are not retried
 * here; a caller must read the authoritative Job again first. */
export async function cancelHostedTrainingJob(client: Client, jobId: string, teamId: string): Promise<TrainingJob> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await client.getJob(jobId);
    assertJobIdentity(current, jobId, teamId);
    if (terminal.has(current.state) || current.state === "cancelling") return current;
    try {
      const cancelled = await client.cancelJob(jobId, current.version);
      assertJobIdentity(cancelled, jobId, teamId, current.submissionHash);
      return cancelled;
    } catch (error) {
      if (!(error instanceof OpenPondTrainingApiError) || error.status !== 409
        || error.code !== "stale_version" || attempt === 3) throw error;
    }
  }
  throw new Error("Hosted cancellation could not reconcile the current Job version.");
}

export async function watchHostedTrainingJob(input: {
  client: Client;
  jobId: string;
  teamId: string;
  options: HostedWatchOptions;
  print(value: unknown): void;
  /** The request wrapper consults this bound before every SDK transport. */
  requestBound: { deadlineAt: number | null };
}): Promise<void> {
  const { client, options, jobId, teamId } = input;
  let cleanupDeadline: number | null = null;
  let submissionHash: string | undefined;
  let cancellationAcknowledged = false;
  for (;;) {
    const bound = Math.min(options.deadlineAt ?? Infinity, cleanupDeadline ?? Infinity);
    input.requestBound.deadlineAt = Number.isFinite(bound) ? bound : null;
    if (Date.now() >= bound) throw cleanupDeadlineError(jobId);
    try {
      let job: TrainingJob = options.cancelAt !== null && Date.now() >= options.cancelAt && !cancellationAcknowledged
        ? await cancelHostedTrainingJob(client, jobId, teamId)
        : await client.getJob(jobId);
      assertJobIdentity(job, jobId, teamId, submissionHash);
      submissionHash = job.submissionHash;
      if (options.cancelOnInfrastructureError && !cancellationAcknowledged && !terminal.has(job.state) && job.state !== "cancelling") {
        const events = await client.events(jobId);
        if (events.some(event => event.jobId !== jobId)) throw new Error("Hosted event does not match the watched Job.");
        const failure = events.find(event => event.type === "rollout_metric"
          && event.data.terminalClass === "infrastructure" && event.data.rewardEligible === false);
        if (failure) {
          input.print({ jobId, event: "hosted_watch_infrastructure_failure", trajectoryEventId: failure.id, data: failure.data });
          job = await cancelHostedTrainingJob(client, jobId, teamId);
          assertJobIdentity(job, jobId, teamId, submissionHash);
          cleanupDeadline ??= Date.now() + options.cleanupTimeoutMs;
        }
      }
      cancellationAcknowledged ||= job.state === "cancelling" || terminal.has(job.state);
      input.print(job);
      if (terminal.has(job.state)) {
        const qualificationSucceeded = job.executionMode === "qualification" && job.state === "succeeded";
        if (!options.waitForCleanup && !qualificationSucceeded) return;
        cleanupDeadline ??= Date.now() + options.cleanupTimeoutMs;
        input.requestBound.deadlineAt = Math.min(options.deadlineAt ?? Infinity, cleanupDeadline);
        const { receipt, outputs } = await client.outputs(jobId);
        if (receipt) {
          if (receipt.jobId !== jobId || receipt.teamId !== teamId || receipt.submissionHash !== submissionHash)
            throw new Error("Hosted cleanup receipt does not match the watched Job and submission.");
          if (receipt.cleanupComplete) {
            if (qualificationSucceeded) await assertTrainingQualificationReceipt(receipt, { submissionHash, outputs });
            input.print({ jobId, cleanup: { scope: "job", complete: true, receipt } });
            return;
          }
        }
      }
    } catch (error) {
      if (input.requestBound.deadlineAt !== null && Date.now() >= input.requestBound.deadlineAt)
        throw cleanupDeadlineError(jobId);
      // A bounded watchdog survives transient read/transport failures; the
      // next cancellation attempt still starts with a fresh authoritative GET.
      if ((options.deadlineAt === null && cleanupDeadline === null) || !isTransient(error)) throw error;
      console.error(JSON.stringify({ jobId, event: "hosted_watch_retry", code: error instanceof OpenPondTrainingApiError ? error.code : "transport_unavailable" }));
    }
    const nextBoundary = Math.min(
      input.requestBound.deadlineAt ?? Infinity,
      !cancellationAcknowledged && options.cancelAt !== null && Date.now() < options.cancelAt ? options.cancelAt : Infinity,
    );
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(options.intervalMs, nextBoundary - Date.now()))));
  }
}

function assertJobIdentity(job: TrainingJob, jobId: string, teamId: string, submissionHash?: string): void {
  if (job.id !== jobId || job.teamId !== teamId || submissionHash !== undefined && job.submissionHash !== submissionHash)
    throw new Error("Hosted response does not match the requested Job, workspace, and submission.");
}

function isTransient(error: unknown): boolean {
  if (error instanceof OpenPondTrainingApiError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
}

function cleanupDeadlineError(jobId: string): Error {
  return new Error(`Hosted watch deadline reached for ${jobId}; completed job cleanup is unverified. Inspect hosted-status, hosted-artifacts, and provider retirement before treating resources as released.`);
}
