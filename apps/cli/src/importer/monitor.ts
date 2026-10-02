import { emitKeypressEvents } from "node:readline";
import { collectorStatus } from "@openpond/evals/native-conversations";

export async function monitorImport(input: {
  directory: string;
  connectionId: string;
  keepSyncing: boolean;
  pause(): Promise<void>;
}) {
  console.log(
    "Ctrl+C closes this view and keeps syncing. Ctrl+D pauses this connection.",
  );
  const controller = new AbortController();
  const detach = () => controller.abort();
  let pausing = false;
  const wasRaw = process.stdin.isRaw;
  const keypress = (_text: string, key?: { ctrl?: boolean; name?: string }) => {
    if (!key?.ctrl) return;
    if (key.name === "c") detach();
    if (key.name === "d" && !pausing) {
      pausing = true;
      void input
        .pause()
        .then(detach)
        .catch((error: unknown) => {
          console.error(
            `\nUnable to pause: ${error instanceof Error ? error.message : "connection update failed"}`,
          );
          pausing = false;
        });
    }
  };
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", keypress);
  process.stdin.once("end", detach);
  process.once("SIGINT", detach);
  let spinner = 0;
  try {
    while (!controller.signal.aborted) {
      const status = await collectorStatus(input.directory);
      const item = status.connections.find(
        (row) => row.id === input.connectionId,
      );
      if (!item) break;
      const plan = item.backfill;
      const completed = plan.admitted + plan.skipped;
      const ratio = plan.total
        ? completed / plan.total
        : plan.stage === "complete"
          ? 1
          : 0;
      const filled = Math.max(0, Math.min(20, Math.floor(ratio * 20)));
      const progress =
        plan.stage === "discovering"
          ? `${["|", "/", "-", "\\"][spinner++ % 4]} Discovering conversations (${plan.total} found)`
          : `[${"=".repeat(filled)}${" ".repeat(20 - filled)}] ${completed}/${plan.total} conversations`;
      const state = !status.running
        ? "Service offline"
        : item.state !== "active"
          ? item.state
          : plan.stage === "complete"
            ? input.keepSyncing
              ? "Watching for new conversations"
              : "Import complete"
            : plan.stage;
      const line = `${progress}  ${item.admitted} tasks admitted  ${plan.skipped} skipped  ${plan.failed} need attention  ${item.queued} queued  ${item.error || state}${item.lastAdmissionAt ? `  Last sync ${item.lastAdmissionAt}` : ""}`;
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(line);
      if (!input.keepSyncing && item.state === "paused" && item.queued === 0)
        break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        controller.signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    process.stdin.off("keypress", keypress);
    process.stdin.off("end", detach);
    process.off("SIGINT", detach);
    process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
    console.log();
  }
}
