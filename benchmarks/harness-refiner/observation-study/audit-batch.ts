import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactManifestSchema,
  AttemptReceiptSchema,
  CanonicalRolloutRecordSchema,
  RewardReceiptSchema,
  verifyArtifactManifest,
  verifyAttemptReceipt,
  verifyCanonicalRolloutRecord,
  verifyRewardReceipt,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";

const RECEIPT_PATH = process.env.OPENPOND_REFINER_OBSERVATION_RECEIPT?.trim();
if (!RECEIPT_PATH) throw new Error("OPENPOND_REFINER_OBSERVATION_RECEIPT is required.");
const OUTPUT_PATH = path.resolve(
  process.env.OPENPOND_REFINER_OBSERVATION_AUDIT_OUTPUT?.trim()
    || path.join("output", "harness-refiner-observation-study", "2026-08-17", "canonical-50-audit.json"),
);

const receipt = recordValue(JSON.parse(await readFile(path.resolve(RECEIPT_PATH), "utf8")));
if (receipt.schemaVersion !== "openpond.harnessRefinerObservationBatch.v3") {
  throw new Error("The receipt is not a canonical observation batch v3 receipt.");
}
const tasks = arrayValue(receipt.tasks).map(recordValue);
const promptIds = tasks.map((task) => integerValue(task.promptId));
if (promptIds.some((id) => id === null) || new Set(promptIds).size !== promptIds.length) {
  throw new Error("Observation receipts require unique integer prompt IDs.");
}

const rows = tasks.map((task) => {
  const canonical = recordValue(task.canonical);
  const attemptReceipt = AttemptReceiptSchema.parse(canonical.attemptReceipt);
  const artifactManifest = ArtifactManifestSchema.parse(canonical.artifactManifest);
  const rewardReceipt = RewardReceiptSchema.parse(canonical.rewardReceipt);
  const rolloutRecord = CanonicalRolloutRecordSchema.parse(canonical.rolloutRecord);
  const verification = {
    attemptReceipt: verifyAttemptReceipt(attemptReceipt),
    artifactManifest: verifyArtifactManifest(artifactManifest),
    rewardReceipt: verifyRewardReceipt(rewardReceipt),
    rolloutRecord: verifyCanonicalRolloutRecord(rolloutRecord),
  };
  const trigger = nullableRecord(task.trigger);
  const outcome = nullableRecord(task.outcome);
  const admittedHarness = nullableRecord(task.admittedHarness);
  const resultingHarness = nullableRecord(task.resultingHarness);
  return {
    promptId: integerValue(task.promptId),
    outputKind: stringValue(task.outputKind),
    attemptId: stringValue(task.attemptId),
    sessionId: stringValue(task.sessionId),
    turnId: stringValue(task.turnId),
    admittedHarness,
    resultingHarness,
    harnessChanged: stringValue(admittedHarness?.contentHash) !== stringValue(resultingHarness?.contentHash),
    reward: {
      status: rewardReceipt.status,
      value: rewardReceipt.reward,
      passed: rewardReceipt.passed,
      learningEligible: rewardReceipt.learningEligible,
      outcomeClass: rewardReceipt.outcomeClass,
      failureOwner: rewardReceipt.failureOwner,
    },
    artifacts: {
      entries: artifactManifest.entries.length,
      collected: artifactManifest.entries.filter((entry) => entry.status === "collected").length,
      missing: artifactManifest.entries.filter((entry) => entry.status !== "collected").length,
    },
    refiner: {
      triggerDecision: stringValue(trigger?.decision),
      outcomeDecision: stringValue(outcome?.decision),
      routed: outcome?.metadata && recordValue(outcome.metadata).routed === true,
      route: outcome?.metadata ? stringValue(recordValue(outcome.metadata).route) : null,
    },
    usage: {
      foregroundTokens: usageTotal(task.foregroundUsage),
      backgroundTokens: usageTotal(task.refinerUsage),
    },
    verification,
  };
});
const invalidRows = rows.filter((row) => Object.values(row.verification).some((valid) => !valid));
if (invalidRows.length) {
  throw new Error(`Canonical verification failed for prompts ${invalidRows.map((row) => row.promptId).join(", ")}.`);
}
const summary = {
  attempted: rows.length,
  scored: rows.filter((row) => row.reward.status === "scored").length,
  passed: rows.filter((row) => row.reward.passed).length,
  zeroReward: rows.filter((row) => row.reward.value === 0).length,
  unscorable: rows.filter((row) => row.reward.status === "unscorable").length,
  learningEligible: rows.filter((row) => row.reward.learningEligible).length,
  canonicalVerified: rows.length - invalidRows.length,
  reviewedByRefiner: rows.filter((row) => row.refiner.outcomeDecision !== null).length,
  proposed: rows.filter((row) => row.refiner.outcomeDecision === "proposed").length,
  noAction: rows.filter((row) => row.refiner.outcomeDecision === "no_action").length,
  routed: rows.filter((row) => row.refiner.routed).length,
  harnessTransitions: rows.filter((row) => row.harnessChanged).length,
  missingRequiredOutputs: rows.reduce((total, row) => total + row.artifacts.missing, 0),
  foregroundTokens: rows.reduce((total, row) => total + row.usage.foregroundTokens, 0),
  backgroundTokens: rows.reduce((total, row) => total + row.usage.backgroundTokens, 0),
};
const content = {
  schemaVersion: "openpond.harnessRefinerObservationAudit.v2",
  study: receipt.study,
  orderSeed: receipt.orderSeed,
  selectedTaskIds: receipt.selectedTaskIds,
  generatedAt: new Date().toISOString(),
  initialHarness: receipt.initialHarness,
  finalHarness: receipt.finalHarness,
  summary,
  tasks: rows,
};
const audit = { ...content, contentHash: contentHash(content) };
await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(summary)}\n${OUTPUT_PATH}\n`);

function usageTotal(value: unknown): number {
  return arrayValue(value).reduce((total, usage) => {
    const record = recordValue(usage);
    const reported = numberValue(record.total_tokens ?? record.totalTokens);
    return total + (reported ?? (numberValue(record.input_tokens ?? record.prompt_tokens ?? record.promptTokens) ?? 0)
      + (numberValue(record.output_tokens ?? record.completion_tokens ?? record.completionTokens) ?? 0));
  }, 0);
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return nullableRecord(value) ?? {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
