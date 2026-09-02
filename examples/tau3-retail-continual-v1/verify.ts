import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContinualBenchPortableReportSchema,
  createContinualBenchReport,
  exportContinualBenchReport,
  validateContinualBenchManifest,
  verifyGoldenMigrationFixture,
} from "@openpond/continual-bench";
const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(directory, "continual-bench.json"), "utf8"));
const validation = validateContinualBenchManifest(manifest);
if (!validation.valid) throw new Error(validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));

const golden = JSON.parse(await readFile(path.join(directory, "golden-migration.json"), "utf8"));
if (!verifyGoldenMigrationFixture(golden)) throw new Error("The Tau3 v3 golden split no longer reproduces its sealed hash and allocations.");

const report = createContinualBenchReport({
  schemaVersion: "openpond.continualBenchReport.v1",
  seriesId: "tau3-retail-continual-v1-fixture",
  protocol: { id: "tau3-retail-continual-v1-fixture-protocol", revision: 1, contentHash: validation.manifestHash! },
  generatedAt: "2026-09-01T00:00:00.000Z",
  status: "terminal",
  points: [
    fixturePoint("fixture-base", "Original base", "base", null, 0.5, [0.38, 0.62], 0, 0),
    fixturePoint("fixture-p0", "P0", "candidate", 0, 0.67, [0.54, 0.78], 1_240, 3.8),
    fixturePoint("fixture-p1", "P1", "candidate", 1, 0.75, [0.63, 0.84], 1_860, 5.5),
    fixturePoint("fixture-p2", "P2", "candidate", 2, 0.83, [0.72, 0.91], 2_410, 7.2),
  ],
  outcomes: ["systems_complete", "correction_absorbed", "issue_generalized"],
  audit: [
    { requirement: "family-level-split", status: "passed", evidenceRefs: [golden.expectedSplitHash] },
    { requirement: "leakage-audit", status: "passed", evidenceRefs: [golden.expectedLeakageHash] },
    { requirement: "receipt-derived-scorecard", status: "passed", evidenceRefs: ["fixture-base", "fixture-p0", "fixture-p1", "fixture-p2"] },
  ],
});
const reportPath = path.join(directory, "fixture-report.json");
const serialized = exportContinualBenchReport(report);
if (process.argv.includes("--write")) await writeFile(reportPath, serialized, "utf8");
else {
  const stored = ContinualBenchPortableReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
  if (exportContinualBenchReport(stored) !== serialized) throw new Error("fixture-report.json has drifted from its deterministic generator.");
}

process.stdout.write(`${JSON.stringify({ manifestHash: validation.manifestHash, leakageHash: validation.leakageHash, goldenSplitHash: golden.expectedSplitHash, reportHash: report.contentHash }, null, 2)}\n`);

function fixturePoint(
  id: string,
  label: string,
  kind: "candidate" | "base",
  ordinal: number | null,
  meanScore: number,
  confidenceInterval: [number, number],
  gpuSeconds: number,
  costUsd: number,
) {
  return {
    id, label, kind, ordinal, meanScore, confidenceInterval, taskMetrics: [],
    efficiency: {
      targetId: id,
      trainingGpuSeconds: gpuSeconds,
      evaluationGpuSeconds: 480,
      providerSpendUsd: 0,
      totalSpendUsd: costUsd,
      durationSeconds: gpuSeconds + 480,
      optimizerGroups: ordinal === null ? 0 : ordinal + 1,
      trajectories: ordinal === null ? 0 : (ordinal + 1) * 4,
    },
    evidenceUrl: `https://openpond.ai/models/comparisons/tau3-retail-continual-v1-fixture?point=${id}`,
  } as const;
}
