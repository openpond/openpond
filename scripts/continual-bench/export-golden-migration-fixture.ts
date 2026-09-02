import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (!sourcePath || !outputPath) throw new Error("usage: tsx export-golden-migration-fixture.ts <preparation.json> <output.json>");

const preparation = JSON.parse(await readFile(path.resolve(sourcePath), "utf8")) as {
  split: { seed: string; allocations: unknown[]; families: unknown[]; contentHash: string };
  leakage: { contentHash: string };
};
const fixture = {
  schemaVersion: "openpond.continualBenchGoldenMigration.v1",
  source: { repository: "https://github.com/sierra-research/tau3", commit: "a2c024725189473d2d7cea3a5cfdbcc67478e41f" },
  seed: preparation.split.seed,
  correctionSelection: "minimize_prompt_similarity",
  expectedSplitHash: preparation.split.contentHash,
  expectedLeakageHash: preparation.leakage.contentHash,
  allocations: preparation.split.allocations,
  families: preparation.split.families,
};
await writeFile(path.resolve(outputPath), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
