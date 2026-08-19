import { SqliteStore } from "../../../apps/server/src/store/store.js";
import { runCrossWorkQualification } from "./cross-work.js";
import { QualificationModelMeter } from "./model-meter.js";

const storeDir = process.env.OPENPOND_APP_HOME?.trim();
if (!storeDir) throw new Error("OPENPOND_APP_HOME is required for Q6 qualification.");
const store = new SqliteStore(storeDir);
const meter = new QualificationModelMeter();
try {
  const result = await runCrossWorkQualification({ store, storeDir, meter });
  process.stdout.write(`${JSON.stringify({
    classification: result.review.classification,
    candidateStatus: result.candidate.status,
    independentOccurrences: result.candidate.occurrences.length,
    continuationCount: 1,
    duplicateContinuationCount: 0,
    modelUsage: meter.snapshot(),
  })}\n`);
} finally {
  await store.close();
}
