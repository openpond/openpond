import { readdir } from "node:fs/promises";
import path from "node:path";

import { traceDir } from "../core/constants";
import type { CliOptions } from "../core/types";

export async function tracesCommand(options: CliOptions) {
  const tracesDir = traceDir(options.outDir);
  try {
    const traces = (await readdir(path.join(options.cwd, tracesDir)))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort();
    if (options.json) {
      console.log(JSON.stringify({ traces: traces.map((trace) => path.join(tracesDir, trace)) }, null, 2));
      return;
    }
    if (traces.length === 0) console.log("No trace artifacts.");
    else for (const trace of traces) console.log(path.join(tracesDir, trace));
  } catch {
    console.log(options.json ? JSON.stringify({ traces: [] }, null, 2) : "No trace artifacts.");
  }
}
