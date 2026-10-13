import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { optionString } from "./common";
import { createSignalPlan, SignalThresholdsSchema } from "./experiments-signal-plan";
import { createSignalReport } from "./experiments-signal-report";

async function readJson(path: string, limit = 64 * 1024 * 1024): Promise<unknown> {
  if ((await stat(path)).size > limit) throw new Error(`Signal input exceeds ${limit} bytes: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}
/** Offline only: use the official preparation/result commands to obtain retained inputs. */
export async function runExperimentsSignalCommand(options: Record<string, string | boolean>, rest: string[]) {
  const file = optionString(options, "inputFile");
  if (!file || rest.length !== 1) throw new Error("usage: experiments <signal-plan|signal-report> --input-file <path>");
  const raw = await readJson(file, 1048576), base = dirname(resolve(file));
  let result: unknown;
  if (rest[0] === "signal-plan") {
    const input = z.object({ packageFile: z.string().min(1), preparationFile: z.string().min(1), thresholds: SignalThresholdsSchema }).strict().parse(raw);
    result = createSignalPlan({ package: await readJson(resolve(base, input.packageFile)),
      preparation: await readJson(resolve(base, input.preparationFile)), thresholds: input.thresholds });
  } else {
    const input = z.object({ planFile: z.string().min(1), resultFile: z.string().min(1) }).strict().parse(raw);
    result = createSignalReport(await readJson(resolve(base, input.planFile)), await readJson(resolve(base, input.resultFile)));
  }
  console.log(JSON.stringify(result, null, 2));
}
