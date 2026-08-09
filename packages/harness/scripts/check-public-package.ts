import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const dependencies = Object.keys(manifest.dependencies ?? {});
if (dependencies.join(",") !== "zod") {
  throw new Error(`@openpond/harness may depend only on zod; found ${dependencies.join(", ") || "none"}.`);
}

const forbidden = /(?:@openpond\/|electron|next\/|better-sqlite|node:sqlite|connected-app|provider sdk)/i;
const privateRefinerImplementation = /(?:authorLocalHarnessRefinementWithModel|LocalHarnessRefinerModelStream|refinerMessages|privateHarnessRefinerEnvelope|You are OpenPond's (?:private )?bounded Harness Refiner)/;
for (const file of await sourceFiles(path.join(root, "src"))) {
  const source = await readFile(file, "utf8");
  if (forbidden.test(source)) {
    throw new Error(`Application-only dependency marker found in ${path.relative(root, file)}.`);
  }
  if (privateRefinerImplementation.test(source)) {
    throw new Error(`Private Refiner implementation marker found in ${path.relative(root, file)}.`);
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const name of await readdir(directory)) {
    const target = path.join(directory, name);
    if ((await stat(target)).isDirectory()) output.push(...await sourceFiles(target));
    else if (target.endsWith(".ts")) output.push(target);
  }
  return output;
}
