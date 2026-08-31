import path from "node:path";

import { materializeHarveyLabLegalTaskset } from "./taskset.js";

const outputFlag = process.argv.indexOf("--output-dir");
const outputDir = outputFlag >= 0 ? process.argv[outputFlag + 1] : null;
const releaseFlag = process.argv.indexOf("--release-stage");
const releaseStage = releaseFlag >= 0 ? process.argv[releaseFlag + 1] : "week0";
if (!outputDir) {
  throw new Error(
    "Usage: pnpm tsx examples/training/legal-contract-review/build.ts --output-dir <directory> [--release-stage week0|all]",
  );
}
if (releaseStage !== "week0" && releaseStage !== "all") {
  throw new Error("--release-stage must be week0 or all");
}

const result = await materializeHarveyLabLegalTaskset({
  outputDir: path.resolve(outputDir),
  releaseStage,
});

console.log(JSON.stringify({
  tasksetId: result.taskset.id,
  tasksetHash: result.taskset.contentHash,
  tasksetRoot: result.tasksetRoot,
  sourceRevision: result.sourceRevision,
  taskCount: result.taskset.tasks.length,
  splitCounts: Object.fromEntries(
    ["train", "validation", "frozen_eval"].map((split) => [
      split,
      result.taskset.tasks.filter((task) => task.split === split).length,
    ]),
  ),
  assetCount: result.assetCount,
  assetBytes: result.assetBytes,
}, null, 2));
