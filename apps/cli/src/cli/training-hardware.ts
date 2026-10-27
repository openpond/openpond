import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHardwareObservationClient } from "openpond-sdk/training-hardware";
import { hostedTrainingAccount } from "./hosted-training-account";
import { trainingCliError } from "./common/training-error";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";

/** One authenticated read-only session. Writes honor stdout backpressure, so a
 * slow viewer never queues observations or starts overlapping API requests. */
export async function runHardwareObservations(
  options: Record<string, string | boolean>,
  rest: string[],
) {
  if (rest.length !== 1)
    throw new Error("hosted-hardware does not accept an identifier; use --worker-id or --job-id.");
  const watch = parseBooleanOption(options.watch);
  if (watch && !parseBooleanOption(options.json))
    throw new Error("hosted-hardware --watch requires --json for bounded NDJSON output.");
  const interval =
    options.intervalMs === undefined
      ? 1000
      : (parseIntegerOption(options.intervalMs, "interval-ms") ?? 1000);
  const timeout =
    options.timeoutMs === undefined
      ? 15_000
      : (parseIntegerOption(options.timeoutMs, "timeout-ms") ?? 15_000);
  if (interval < 100 || interval > 60_000 || timeout < 1000 || timeout > 60_000)
    throw new Error("Hardware interval must be 100..60000 ms and timeout 1000..60000 ms.");
  const { baseUrl, teamId, headers } = await hostedTrainingAccount(options);
  const stop = new AbortController();
  const abort = () => stop.abort();
  const brokenPipe = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") abort();
    else {
      abort();
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  process.stdout.on("error", brokenPipe);
  const client = createHardwareObservationClient({
    baseUrl,
    headers,
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          stop.signal,
          AbortSignal.timeout(timeout),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  });
  const query = {
    teamId,
    workerId: optionString(options, "workerId") || undefined,
    jobId: optionString(options, "jobId") || undefined,
    cursor: optionString(options, "cursor") || undefined,
    limit: options.limit === undefined ? undefined : parseIntegerOption(options.limit, "limit"),
  };
  try {
    do {
      const started = Date.now();
      let record: unknown;
      try {
        const snapshot = await client.hardwareObservations(query);
        if (!watch) {
          console.log(JSON.stringify(snapshot, null, 2));
          return;
        }
        record = { schemaVersion: "openpond.hardwareWatch.v1", kind: "snapshot", snapshot };
      } catch (error) {
        if (stop.signal.aborted) return;
        if (!watch) throw error;
        record = {
          schemaVersion: "openpond.hardwareWatch.v1",
          kind: "error",
          error: trainingCliError(error) ?? {
            code: "HARDWARE_READ_FAILED",
            message: error instanceof Error ? error.message.slice(0, 512) : "Hardware read failed.",
          },
        };
      }
      const line = JSON.stringify(record) + "\n";
      if (Buffer.byteLength(line) > 8 * 1024 * 1024 + 1024)
        throw new Error("Hardware watch record exceeds its wire bound.");
      if (!process.stdout.write(line)) await once(process.stdout, "drain", { signal: stop.signal });
      await delay(Math.max(0, interval - (Date.now() - started)), undefined, {
        signal: stop.signal,
      });
    } while (!stop.signal.aborted);
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
    process.stdout.off("error", brokenPipe);
  }
}
