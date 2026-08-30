import path from "node:path";

import { materializeHarveyLabLegalTaskset } from "../packages/taskset-sdk/src/index.js";
import { SqliteStore } from "../apps/server/src/store/store.js";

const storeFlag = process.argv.indexOf("--store-dir");
const storeDir = storeFlag >= 0 ? process.argv[storeFlag + 1] : null;
const releaseFlag = process.argv.indexOf("--release-stage");
const releaseStage = releaseFlag >= 0 ? process.argv[releaseFlag + 1] : "all";
const upsert = process.argv.includes("--upsert");
if (!storeDir) {
  throw new Error(
    "Usage: pnpm tsx scripts/materialize-harvey-lab-legal-taskset.ts --store-dir <directory> [--release-stage week0|all] [--upsert]",
  );
}
if (releaseStage !== "week0" && releaseStage !== "all") {
  throw new Error("--release-stage must be week0 or all");
}

const result = await materializeHarveyLabLegalTaskset({
  storeDir: path.resolve(storeDir),
  releaseStage,
});
if (upsert) {
  const store = new SqliteStore(path.resolve(storeDir));
  try {
    await store.upsertTaskset(result.taskset);
  } finally {
    await store.close();
  }
}

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
  upserted: upsert,
}, null, 2));
