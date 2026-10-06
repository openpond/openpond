import { Worker } from "node:worker_threads";
import { workbookInspectorSource } from "./workbook-inspector-source.js";
import {
  WORKBOOK_INSPECTION_MAX_RESULT_BYTES,
  type WorkbookInspection,
} from "./workbook-inspection-contract.js";

/** Parse/recalculate outside the app event loop, with empty environment and a
 * hard deadline. The worker contains trusted code only, never authored scripts. */
export async function inspectWorkbook(input: {
  bytes: Uint8Array;
  probeSheets?: string[];
  signal?: AbortSignal;
}): Promise<WorkbookInspection> {
  input.signal?.throwIfAborted();
  if (input.bytes.length > 10_000_000)
    throw new Error("Workbook exceeds the retained input limit.");
  return new Promise((resolve, reject) => {
    const worker = new Worker(workbookInspectorSource, {
      eval: true,
      execArgv: [],
      env: {},
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      workerData: { bytes: input.bytes, probeSheets: input.probeSheets ?? [] },
    });
    let settled = false;
    const finish = (result: WorkbookInspection | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      void worker
        .terminate()
        .then(
          () => (result instanceof Error ? reject(result) : resolve(result)),
          reject,
        );
    };
    const cancel = () =>
      finish(
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new Error("Workbook inspection cancelled."),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error("Workbook inspection exceeded its 15-second deadline."),
        ),
      15_000,
    );
    input.signal?.addEventListener("abort", cancel, { once: true });
    worker.once("error", finish);
    worker.once("exit", () =>
      finish(new Error("Workbook inspection stopped without a result.")),
    );
    worker.once("message", (value: unknown) => {
      if (
        typeof value !== "string" ||
        Buffer.byteLength(value) > WORKBOOK_INSPECTION_MAX_RESULT_BYTES
      ) {
        finish(new Error("Workbook inspection exceeded its evidence limit."));
        return;
      }
      try {
        finish(JSON.parse(value) as WorkbookInspection);
      } catch {
        finish(new Error("Workbook inspection returned invalid evidence."));
      }
    });
    if (input.signal?.aborted) cancel();
  });
}
