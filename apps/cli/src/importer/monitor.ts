import { collectorStatus } from "@openpond/evals/native-conversations";
import { setTimeout as delay } from "node:timers/promises";

/** Foreground progress ends with the job. Ctrl+C cancels the worker itself. */
export async function monitorImport(input: {
  directory: string; connectionId?: string; signal: AbortSignal;
}) {
  console.log("Importing saved conversations. Ctrl+C cancels this run; queued work is retained.");
  let spinner = 0;
  try {
    while (!input.signal.aborted) {
      const status = await collectorStatus(input.directory);
      const connections = status.connections.filter(item => !input.connectionId || item.id === input.connectionId);
      const current = connections.find(item => item.run?.state === "running");
      const run = current?.run;
      const text = current && run
        ? `${current.source}: ${run.phase} · ${run.processed}/${run.discovered} conversations checked · ${run.uploaded} turns uploaded · ${current.queued} queued`
        : "Starting import…";
      process.stdout.clearLine(0); process.stdout.cursorTo(0);
      process.stdout.write(`${["|", "/", "-", "\\"][spinner++ % 4]} ${text}`);
      try { await delay(500, undefined, { signal: input.signal }); }
      catch { if (!input.signal.aborted) throw new Error("Import progress interrupted."); }
    }
  } finally { process.stdout.clearLine(0); process.stdout.cursorTo(0); }
}
