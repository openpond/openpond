import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { optionString, parseBooleanOption } from "./common/options";
import type { TrainingApiClient } from "./training";

/** The same authenticated app transport owns preview and exact-receipt publication. */
export async function runProjectPreparation(client: TrainingApiClient, file: string, options: Record<string, string | boolean>): Promise<void> {
  const apply = parseBooleanOption(options.apply);
  if (apply && parseBooleanOption(options.dryRun)) throw new Error("Choose --apply or --dry-run.");
  const info = await stat(file);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Provide a project preparation JSON file of at most 64 MiB.");
  const input: unknown = JSON.parse(await readFile(file, "utf8"));
  const result = await client.prepareLocalModelProject(input, apply);
  const output = optionString(options, "output");
  if (output) await writeFile(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (parseBooleanOption(options.json)) console.log(JSON.stringify(result, null, 2));
  else {
    const record = result as { contentHash?: string; preparationHash?: string; project?: { id: string } };
    console.log(apply ? `Saved Model Project ${record.project?.id} from preparation ${record.preparationHash}.` : `Prepared project receipt ${record.contentHash}. No project or resources were saved. Training readiness and execution remain separate.`);
    if (output) console.log(`Wrote ${path.resolve(output)}.`);
    else if (!apply) console.log(JSON.stringify(result, null, 2));
  }
}
