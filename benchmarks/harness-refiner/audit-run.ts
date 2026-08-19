import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentHash } from "@openpond/harness";

type JsonRecord = Record<string, any>;

const runDir = requiredPath("OPENPOND_REFINER_RUN_DIR");
const publicResultPath = path.resolve(
  process.env.OPENPOND_REFINER_PUBLIC_RESULT?.trim()
    || "benchmarks/harness-refiner/results/harness-refiner-20260818-v2.json",
);
const auditPath = path.resolve(
  process.env.OPENPOND_REFINER_AUDIT_OUTPUT?.trim()
    || path.join(runDir, "audit.json"),
);
const qualificationPath = path.resolve(
  process.env.OPENPOND_REFINER_QUALIFICATION?.trim()
    || "output/harness-refiner-qualification/qualification-run10/qualification.json",
);
const admission = await readJson(path.join(runDir, "admission.json"));
const status = await readJson(path.join(runDir, "final-status.json"));
const qualification = await readJson(qualificationPath);
const modelRunId = requiredString(status.runId, "status.runId");
const storeDir = path.join(runDir, "app");
const checkpoint = await readJson(path.join(
  storeDir,
  "training",
  "harness-refiner-benchmarks",
  modelRunId,
  "sequential-adaptation.json",
));
const resultDirectory = path.join(
  storeDir,
  "training",
  "model-runs",
  modelRunId,
  "benchmark",
);
const resultFiles = (await readdir(resultDirectory)).filter((name) => name.endsWith(".json"));
assert(resultFiles.length === 1, "The admitted run must have exactly one result manifest.");
const manifest = await readJson(path.join(resultDirectory, resultFiles[0]!));
const receipt = record(status.receipt, "status.receipt");

verifyHash(admission, "admission");
verifyHash(qualification, "qualification");
verifyHash(checkpoint, "sequential checkpoint");
verifyHash(manifest, "result manifest");
verifyHash(receipt, "evaluation receipt");
assert(status.state === "succeeded", `Expected a succeeded run, received ${status.state}.`);
assert(qualification.status === "passed", "Qualification did not pass.");
assert(
  Array.isArray(qualification.scenarios)
    && qualification.scenarios.length === 6
    && qualification.scenarios.every((scenario: JsonRecord) => scenario.status === "passed"),
  "Qualification must contain six passing scenarios.",
);
assert(admission.plannedAttempts === 40, "Admission must bind forty stage attempts.");
assert(manifest.modelRunId === modelRunId, "Result manifest belongs to another Model Run.");
assert(manifest.contentHash === receipt.resultManifest?.contentHash, "Result receipt hash drifted.");
assert(manifest.tasksetRelease?.id === admission.taskset?.id, "Taskset release id drifted.");
assert(
  manifest.tasksetRelease?.contentHash === admission.taskset?.contentHash,
  "Taskset release hash drifted.",
);
assert(contentHash(manifest.model) === contentHash(admission.model), "Model selection drifted.");
assert(
  contentHash(manifest.upstreamModel) === contentHash(admission.upstreamModel),
  "Upstream model or pricing drifted.",
);
assert(manifest.reasoningEffort === admission.reasoningEffort, "Reasoning effort drifted.");
assert(
  contentHash(manifest.executionPlan) === contentHash(admission.executionPlan),
  "Execution plan drifted.",
);
assert(manifest.publicationPolicy?.primaryReward === "deterministic_output_contract", "Primary reward drifted.");
assert(manifest.publicationPolicy?.supplementaryJudge === "not_executed_uncalibrated", "Unexpected model judge execution.");
assert(manifest.lineage?.valid === true && receipt.lineage?.valid === true, "Harness lineage is invalid.");
assert(checkpoint.modelRunId === modelRunId, "Sequential checkpoint belongs to another run.");
assert(Array.isArray(checkpoint.steps) && checkpoint.steps.length === 10, "Expected ten sequential adaptation steps.");
assert(
  checkpoint.steps.every((step: JsonRecord, ordinal: number) =>
    step.ordinal === ordinal && admission.executionPlan[2]?.taskIds?.[ordinal] === step.taskId
  ),
  "Sequential adaptation task order drifted.",
);
const invocationsByTask = new Map<string, JsonRecord[]>();
for (const invocation of checkpoint.invocations as JsonRecord[]) {
  verifyHash(invocation, `Refiner invocation ${invocation.id}`);
  const invocations = invocationsByTask.get(invocation.taskId) ?? [];
  invocations.push(invocation);
  invocationsByTask.set(invocation.taskId, invocations);
}
for (const step of checkpoint.steps as JsonRecord[]) {
  const invocations = invocationsByTask.get(step.taskId) ?? [];
  assert(invocations.length <= admission.refiner.maxInvocationsPerTask, `Refiner retry limit exceeded for ${step.taskId}.`);
  assert(invocations.at(-1)?.status === "completed", `Refiner did not terminalize ${step.taskId} successfully.`);
  if (step.changed) {
    assert(step.outcome && !["no_action", "route"].includes(step.outcome.decision), `Changed step ${step.taskId} has no mutating outcome.`);
  }
}

const attempts = array(receipt.attempts, "receipt.attempts");
assert(attempts.length === 40, `Expected forty attempts, received ${attempts.length}.`);
const attemptKeys = new Set(attempts.map((attempt) => `${attempt.phase}:${attempt.taskId}`));
assert(attemptKeys.size === 40, "Stage/task attempts are not unique.");
for (const plan of admission.executionPlan as JsonRecord[]) {
  const stageAttempts = attempts.filter((attempt) => attempt.phase === plan.stage);
  assert(stageAttempts.length === plan.attemptCount, `Attempt count drifted for ${plan.stage}.`);
  assert(
    contentHash(stageAttempts.map((attempt) => attempt.taskId)) === contentHash(plan.taskIds),
    `Task order drifted for ${plan.stage}.`,
  );
}
assert(receipt.budget?.enforced === true, "Spend ceiling was not enforced.");
assert(receipt.budget.observedSpendUsd <= receipt.budget.maximumSpendUsd, "Spend ceiling was exceeded.");
assert(receipt.invalidReasons?.length === 0, "The result contains invalidating reasons.");

const pairs = [
  ...pairedAttempts(attempts, "adaptation", "candidate_adaptation", "adaptation"),
  ...pairedAttempts(attempts, "baseline", "candidate", "held_out"),
];
assert(pairs.length === 20, "Expected twenty canonical attempt pairs.");
const adaptationPairs = pairs.filter((pair) => pair.cohort === "adaptation");
const heldOutPairs = pairs.filter((pair) => pair.cohort === "held_out");
const changedSteps = (checkpoint.steps as JsonRecord[]).filter((step) => step.changed);
const publicCore = {
  schemaVersion: "openpond.harnessRefinerPublicResult.v2",
  id: "harness-refiner-20260818-v2",
  completedAt: manifest.createdAt,
  outcome: receipt.terminalClassification,
  source: {
    tasksetRelease: manifest.tasksetRelease,
    resultManifestContentHash: manifest.contentHash,
    evaluationReceiptContentHash: receipt.contentHash,
    qualificationContentHash: qualification.contentHash,
    admissionContentHash: admission.contentHash,
    reward: "deterministic_output_contract",
    supplementaryJudge: "not_executed_uncalibrated",
    model: {
      provider: "OpenPond Chat",
      model: "DeepSeek V4 Flash",
      upstreamRevision: manifest.upstreamModel.revision,
      reasoningEffort: manifest.reasoningEffort,
    },
  },
  harness: {
    baselineContentHash: manifest.harness.baseline.contentHash,
    finalContentHash: manifest.harness.candidate.contentHash,
    lineageValid: manifest.lineage.valid,
    changedStepCount: changedSteps.length,
    changedAfterTaskIds: changedSteps.map((step) => step.taskId),
    decisions: decisionCounts(checkpoint.steps),
    failedInvocationCount: (checkpoint.invocations as JsonRecord[])
      .filter((invocation) => invocation.status === "failed").length,
  },
  aggregates: {
    adaptation: aggregate(adaptationPairs),
    heldOut: aggregate(heldOutPairs),
    allTasks: aggregate(pairs),
    refiner: {
      inputTokens: receipt.usage.refiner.inputTokens,
      outputTokens: receipt.usage.refiner.outputTokens,
      totalTokens: receipt.usage.refiner.totalTokens,
      costUsd: receipt.usage.refiner.costUsd,
    },
    spend: receipt.budget,
  },
  quality: receipt.quality,
  efficiency: receipt.efficiency,
  taskEfficiency: receipt.taskEfficiency,
  pairs,
  limits: {
    taskCount: 20,
    attemptCount: 40,
    refinerTimeoutMs: admission.refiner.timeoutMs,
    maximumRefinerInvocationsPerTask: admission.refiner.maxInvocationsPerTask,
    uncertainty: manifest.publicationPolicy.uncertainty,
  },
};
const publicResult = { ...publicCore, contentHash: contentHash(publicCore) };
const auditCore = {
  schemaVersion: "openpond.harnessRefinerBenchmarkAudit.v1",
  id: `harness-refiner-audit-${modelRunId}`,
  auditedAt: new Date().toISOString(),
  status: "passed",
  refs: {
    modelRunId,
    admission: { id: admission.id, contentHash: admission.contentHash },
    qualification: { id: qualification.id, contentHash: qualification.contentHash },
    result: { id: manifest.id, contentHash: manifest.contentHash },
    receipt: { contentHash: receipt.contentHash },
    checkpoint: { contentHash: checkpoint.contentHash },
    publicResult: { id: publicResult.id, contentHash: publicResult.contentHash },
  },
  invariants: {
    qualificationScenariosPassed: 6,
    plannedAttempts: 40,
    terminalAttempts: attempts.length,
    canonicalPairs: pairs.length,
    sequentialSteps: checkpoint.steps.length,
    lineageValid: true,
    deterministicRewardOnly: true,
    spendWithinCeiling: true,
  },
};
const audit = { ...auditCore, contentHash: contentHash(auditCore) };
await writeFile(publicResultPath, `${JSON.stringify(publicResult, null, 2)}\n`, "utf8");
await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  status: "passed",
  modelRunId,
  outcome: publicResult.outcome,
  pairs: pairs.length,
  changedSteps: changedSteps.length,
  observedSpendUsd: receipt.budget.observedSpendUsd,
  publicResultPath,
  publicResultContentHash: publicResult.contentHash,
  auditPath,
  auditContentHash: audit.contentHash,
})}\n`);

function pairedAttempts(
  attempts: JsonRecord[],
  baselinePhase: string,
  candidatePhase: string,
  cohort: "adaptation" | "held_out",
) {
  const baseline = new Map(
    attempts.filter((attempt) => attempt.phase === baselinePhase)
      .map((attempt) => [attempt.taskId, attempt]),
  );
  return attempts.filter((attempt) => attempt.phase === candidatePhase).map((candidate) => {
    const prior = baseline.get(candidate.taskId);
    assert(prior, `Missing ${baselinePhase} pair for ${candidate.taskId}.`);
    return {
      cohort,
      taskId: candidate.taskId,
      baselineTokens: prior.totalTokens,
      refinedTokens: candidate.totalTokens,
      tokenDelta: candidate.totalTokens - prior.totalTokens,
      baselinePassed: prior.passed,
      refinedPassed: candidate.passed,
    };
  });
}

function aggregate(pairs: JsonRecord[]) {
  const baselineTokens = sum(pairs, "baselineTokens");
  const refinedTokens = sum(pairs, "refinedTokens");
  const tokenDelta = refinedTokens - baselineTokens;
  return {
    baselineTokens,
    refinedTokens,
    tokenDelta,
    tokenDeltaPercent: baselineTokens ? tokenDelta / baselineTokens * 100 : null,
    lowerTaskCount: pairs.filter((pair) => pair.tokenDelta < 0).length,
    higherTaskCount: pairs.filter((pair) => pair.tokenDelta > 0).length,
    unchangedTaskCount: pairs.filter((pair) => pair.tokenDelta === 0).length,
    baselineQualityPassCount: pairs.filter((pair) => pair.baselinePassed).length,
    refinedQualityPassCount: pairs.filter((pair) => pair.refinedPassed).length,
    taskCount: pairs.length,
  };
}

function decisionCounts(steps: JsonRecord[]) {
  return steps.reduce((counts: Record<string, number>, step) => {
    const decision = step.outcome?.decision ?? step.trigger?.decision ?? "none";
    counts[decision] = (counts[decision] ?? 0) + 1;
    return counts;
  }, {});
}

function sum(values: JsonRecord[], key: string) {
  return values.reduce((total, value) => total + Number(value[key] ?? 0), 0);
}

function verifyHash(value: JsonRecord, label: string) {
  const admitted = requiredString(value.contentHash, `${label}.contentHash`);
  const { contentHash: _, ...core } = value;
  assert(contentHash(core) === admitted, `${label} failed content-hash validation.`);
}

async function readJson(filePath: string): Promise<JsonRecord> {
  return record(JSON.parse(await readFile(filePath, "utf8")), filePath);
}

function requiredPath(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
