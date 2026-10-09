import { collectorStatus, runCollector, scheduleDescription, type CollectorStatus } from "@openpond/evals/native-conversations";
import { collectorTransport } from "./transport";
import { monitorImport } from "./monitor";

export async function runImportJob(input: {
  directory: string; connectionId?: string; json: boolean; scheduled?: boolean; retainedStart?: boolean;
}) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Import cancelled."));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const finished = new AbortController();
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !input.json;
  let status: CollectorStatus;
  try {
    const job = runCollector({ directory: input.directory, signal: controller.signal,
      ...(input.connectionId ? { connectionIds: [input.connectionId] } : {}),
      ...(input.retainedStart ? {} : { trigger: input.scheduled ? "scheduled" as const : "manual" as const }),
      transport: collectorTransport,
    }).finally(() => finished.abort());
    await Promise.all([job, interactive ? monitorImport({ directory: input.directory, connectionId: input.connectionId,
      signal: finished.signal }) : Promise.resolve()]);
    status = await collectorStatus(input.directory);
  } finally {
    finished.abort(); process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
  const connections = status.connections.filter(connection => !input.connectionId || connection.id === input.connectionId);
  if (input.json) console.log(JSON.stringify(status, null, 2));
  else for (const connection of connections) {
    const run = connection.run;
    if (run) console.log(`${connection.source}: ${run.state}. ${run.processed} conversations checked, ${run.uploaded} turns uploaded, ${connection.queued} queued.${run.error ? ` ${run.error}` : ""}`);
    console.log(connection.schedule ? `Continual imports: ${scheduleDescription(connection.schedule)} (${status.timezone}). Next: ${connection.nextRunAt ?? "source paused"}.` : "Automatic sync is off. Run openpond import sync to import again.");
  }
  if (controller.signal.aborted) process.exitCode = 130;
  else if (connections.some(connection => connection.run?.state === "failed")) process.exitCode = 1;
  return status;
}
