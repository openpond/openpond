import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentHash } from "@openpond/harness";

import { rollbackLocalHarnessWorkspaceRelease } from
  "../../../apps/server/src/harness/local-harness-refiner.js";
import { SqliteStore } from "../../../apps/server/src/store/store.js";
import { runCrossWorkQualification } from "./cross-work.js";
import { QualificationModelMeter } from "./model-meter.js";
import {
  HARNESS_REFINER_QUALIFICATION_ID,
  HARNESS_REFINER_QUALIFICATION_LIMITS,
  HARNESS_REFINER_QUALIFICATION_MODEL,
  HARNESS_REFINER_QUALIFICATION_PRICING,
  HARNESS_REFINER_QUALIFICATION_PROTOCOL_HASH,
  HARNESS_REFINER_QUALIFICATION_SCHEMA,
  HARNESS_REFINER_QUALIFICATION_SCENARIOS,
  SEEDED_HTML_DEFECT_AUTHORITY,
} from "./protocol.js";
import {
  createSeededQualificationWorkspace,
  loadRuntime,
  reviewQualificationAttempt,
  runQualificationTask,
  runSyntheticRefinerScenario,
} from "./runtime.js";
import { buildHarnessRefinerQualificationTaskset } from "./taskset.js";

const storeDir = process.env.OPENPOND_APP_HOME?.trim();
if (!storeDir) throw new Error("OPENPOND_APP_HOME is required for qualification.");
const serverUrl = process.env.OPENPOND_APP_SERVER_URL?.trim()
  || "http://127.0.0.1:17874";
const outputPath = path.resolve(
  process.env.OPENPOND_REFINER_QUALIFICATION_OUTPUT?.trim()
    || path.join(
      "output",
      "harness-refiner-qualification",
      HARNESS_REFINER_QUALIFICATION_ID,
      "qualification.json",
    ),
);
const token = (await readFile(path.join(storeDir, "token"), "utf8")).trim();
if (!token) throw new Error("The qualification capability token is empty.");

const store = new SqliteStore(storeDir);
const meter = new QualificationModelMeter();

try {
  const taskset = buildHarnessRefinerQualificationTaskset();
  await store.upsertTaskset(taskset);
  const seeded = await createSeededQualificationWorkspace({
    store,
    storeDir,
    workspaceId: "qualification-per-turn",
  });
  const initialHarness = ref(seeded.release.harnessRelease);
  let runtime = await loadRuntime({ store, workspaceId: seeded.workspace.id });

  process.stdout.write("QUALIFICATION_START q1-clean-success\n");
  const q1Attempt = await runQualificationTask({
    store,
    storeDir,
    serverUrl,
    token,
    taskset,
    task: requireTask(taskset, "qualification-q1-clean-markdown"),
    runtime,
    meter,
    phase: "qualification_q1",
  });
  if (!q1Attempt.rewardReceipt.passed) throw new Error("Q1 did not earn verified reward.");
  const q1Review = await reviewQualificationAttempt({
    store,
    storeDir,
    taskset,
    task: requireTask(taskset, "qualification-q1-clean-markdown"),
    runtime,
    attempt: q1Attempt,
    meter,
  });
  runtime = await loadRuntime({ store, workspaceId: seeded.workspace.id });
  assertUnchanged("Q1", initialHarness, ref(runtime.release.harnessRelease));
  if (q1Review.worker?.proposal) throw new Error("Q1 created a Harness proposal.");
  process.stdout.write("QUALIFICATION_PASS q1-clean-success\n");

  process.stdout.write("QUALIFICATION_START q2-transient-recovery\n");
  const q2 = await runSyntheticRefinerScenario({
    store,
    storeDir,
    runtime,
    meter,
    id: "q2",
  });
  if (!q2.worker || q2.worker.proposal || q2.worker.outcome.metadata.routed === true) {
    throw new Error("Q2 did not skeptically abstain from a transient occurrence.");
  }
  assertUnchanged("Q2", initialHarness, ref(q2.worker.workspace.currentChannel.release!));
  process.stdout.write("QUALIFICATION_PASS q2-transient-recovery\n");

  process.stdout.write("QUALIFICATION_START q3-runtime-owned-failure\n");
  const q3 = await runSyntheticRefinerScenario({
    store,
    storeDir,
    runtime,
    meter,
    id: "q3",
  });
  if (
    q3.worker
    || q3.trigger.decision !== "route_deterministically"
    || q3.trigger.deterministicRoute !== "runtime"
    || q3.route?.route !== "runtime"
    || q3.route.automatic !== true
  ) {
    throw new Error("Q3 did not route the verified runtime-owned failure.");
  }
  runtime = await loadRuntime({ store, workspaceId: seeded.workspace.id });
  assertUnchanged("Q3", initialHarness, ref(runtime.release.harnessRelease));
  process.stdout.write("QUALIFICATION_PASS q3-runtime-owned-failure\n");

  process.stdout.write("QUALIFICATION_START q5-baseline-measurement\n");
  const q5Baseline = await runQualificationTask({
    store,
    storeDir,
    serverUrl,
    token,
    taskset,
    task: requireTask(taskset, "qualification-q5-northgate-museum"),
    runtime,
    meter,
    phase: "qualification_q5_baseline",
  });
  if (q5Baseline.rewardReceipt.reward !== 0) {
    throw new Error("Q5 baseline did not expose the admitted HTML artifact defect.");
  }

  process.stdout.write("QUALIFICATION_START q4-deterministic-html-defect\n");
  const q4Attempt = await runQualificationTask({
    store,
    storeDir,
    serverUrl,
    token,
    taskset,
    task: requireTask(taskset, "qualification-q4-riverbend-clinic"),
    runtime,
    meter,
    phase: "qualification_q4",
  });
  if (q4Attempt.rewardReceipt.reward !== 0) {
    throw new Error("Q4 baseline did not expose the admitted HTML artifact defect.");
  }
  const q4Review = await reviewQualificationAttempt({
    store,
    storeDir,
    taskset,
    task: requireTask(taskset, "qualification-q4-riverbend-clinic"),
    runtime,
    attempt: q4Attempt,
    meter,
    additionalEvidence: SEEDED_HTML_DEFECT_AUTHORITY,
  });
  const q4Worker = q4Review.worker;
  if (
    !q4Worker?.proposal
    || q4Worker.outcome.decision !== "proposed"
    || q4Worker.applyReceipt?.decision !== "applied"
    || q4Worker.advanceReceipt?.decision !== "advanced"
    || q4Worker.validations.some((validation) => validation.status !== "passed")
  ) {
    throw new Error("Q4 did not produce one validated applied Harness correction.");
  }
  runtime = await loadRuntime({ store, workspaceId: seeded.workspace.id });
  const candidateHarness = ref(runtime.release.harnessRelease);
  if (candidateHarness.contentHash === initialHarness.contentHash) {
    throw new Error("Q4 did not advance the immutable Harness release.");
  }
  process.stdout.write("QUALIFICATION_PASS q4-deterministic-html-defect\n");

  process.stdout.write("QUALIFICATION_START q5-fact-distinct-transfer\n");
  const q5Candidate = await runQualificationTask({
    store,
    storeDir,
    serverUrl,
    token,
    taskset,
    task: requireTask(taskset, "qualification-q5-northgate-museum"),
    runtime,
    meter,
    phase: "qualification_q5_candidate",
  });
  if (
    !q5Candidate.rewardReceipt.passed
    || (q5Candidate.rewardReceipt.reward ?? 0) <= (q5Baseline.rewardReceipt.reward ?? 0)
  ) {
    throw new Error("Q5 did not improve verified reward on the fact-distinct task.");
  }
  process.stdout.write("QUALIFICATION_PASS q5-fact-distinct-transfer\n");

  const rollback = await rollbackLocalHarnessWorkspaceRelease({
    store,
    storeDir,
    workspaceId: seeded.workspace.id,
    targetRelease: initialHarness,
    rollbackOf: candidateHarness,
    receiptId: `qualification-rollback-${contentHash(candidateHarness).slice(0, 20)}`,
    now: () => "2026-08-18T16:30:00.000Z",
  });
  if (rollback.receipt.decision !== "rolled_back") {
    throw new Error("Q4 candidate did not preserve a working rollback path.");
  }

  process.stdout.write("QUALIFICATION_START q6-recurring-cross-work\n");
  const q6 = await runCrossWorkQualification({ store, storeDir, meter });
  process.stdout.write("QUALIFICATION_PASS q6-recurring-cross-work\n");

  const completedAt = new Date().toISOString();
  const usage = meter.snapshot();
  const core = {
    schemaVersion: HARNESS_REFINER_QUALIFICATION_SCHEMA,
    id: HARNESS_REFINER_QUALIFICATION_ID,
    protocolHash: HARNESS_REFINER_QUALIFICATION_PROTOCOL_HASH,
    status: "passed" as const,
    model: HARNESS_REFINER_QUALIFICATION_MODEL,
    upstreamModel: HARNESS_REFINER_QUALIFICATION_MODEL.modelId,
    pricing: HARNESS_REFINER_QUALIFICATION_PRICING,
    limits: HARNESS_REFINER_QUALIFICATION_LIMITS,
    taskset: ref(taskset),
    scenarios: [
      {
        id: HARNESS_REFINER_QUALIFICATION_SCENARIOS[0].id,
        status: "passed" as const,
        verifiedReward: q1Attempt.rewardReceipt.reward,
        decision: q1Review.worker?.outcome.decision ?? q1Review.detection?.trigger.decision ?? "not_queued",
        inputHarness: initialHarness,
        outputHarness: initialHarness,
        rewardReceipt: ref(q1Attempt.rewardReceipt),
      },
      {
        id: HARNESS_REFINER_QUALIFICATION_SCENARIOS[1].id,
        status: "passed" as const,
        decision: q2.worker.outcome.decision,
        inputHarness: initialHarness,
        outputHarness: initialHarness,
        outcome: ref(q2.worker!.outcome),
      },
      {
        id: HARNESS_REFINER_QUALIFICATION_SCENARIOS[2].id,
        status: "passed" as const,
        decision: "route_runtime" as const,
        inputHarness: initialHarness,
        outputHarness: initialHarness,
        routeDecision: ref(q3.route!),
      },
      {
        id: HARNESS_REFINER_QUALIFICATION_SCENARIOS[3].id,
        status: "passed" as const,
        baselineReward: q4Attempt.rewardReceipt.reward,
        inputHarness: initialHarness,
        outputHarness: candidateHarness,
        rewardReceipt: ref(q4Attempt.rewardReceipt),
        outcome: ref(q4Worker.outcome),
        proposal: ref(q4Worker.proposal),
        validations: q4Worker.validations.map(ref),
        applyReceipt: ref(q4Worker.applyReceipt),
        advanceReceipt: ref(q4Worker.advanceReceipt),
        rollbackReceipt: ref(rollback.receipt),
      },
      {
        id: HARNESS_REFINER_QUALIFICATION_SCENARIOS[4].id,
        status: "passed" as const,
        baselineReward: q5Baseline.rewardReceipt.reward,
        candidateReward: q5Candidate.rewardReceipt.reward,
        inputHarness: initialHarness,
        outputHarness: candidateHarness,
        baselineRewardReceipt: ref(q5Baseline.rewardReceipt),
        candidateRewardReceipt: ref(q5Candidate.rewardReceipt),
      },
      {
        id: HARNESS_REFINER_QUALIFICATION_SCENARIOS[5].id,
        status: "passed" as const,
        classification: q6.review.classification,
        candidate: ref(q6.candidate),
        candidateStatus: q6.candidate.status,
        independentOccurrences: q6.candidate.occurrences.length,
        continuationRequest: ref(q6.continuationRequest),
        continuationCount: 1,
        duplicateContinuationCount: 0,
        scheduler: {
          cadence: q6.schedule.cadence,
          lastRunAt: q6.schedule.lastRunAt,
          nextRunAt: q6.schedule.nextRunAt,
          lastResult: q6.schedule.lastResult,
          duplicateDueRun: false,
        },
        inputHarness: q6.initialHarness,
        outputHarness: q6.finalHarness,
      },
    ],
    usage,
    completedAt,
  };
  const receipt = { ...core, contentHash: contentHash(core) };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`QUALIFICATION_COMPLETE 6/6 ${outputPath}\n${receipt.contentHash}\n`);
} finally {
  await store.close();
}

function requireTask(taskset: ReturnType<typeof buildHarnessRefinerQualificationTaskset>, id: string) {
  const task = taskset.tasks.find((item) => item.id === id);
  if (!task) throw new Error(`Qualification task ${id} is unavailable.`);
  return task;
}

function assertUnchanged(
  label: string,
  expected: { id: string; contentHash: string },
  actual: { id: string; contentHash: string },
) {
  if (expected.id !== actual.id || expected.contentHash !== actual.contentHash) {
    throw new Error(`${label} unexpectedly changed the Harness release.`);
  }
}

function ref<T extends { id: string; contentHash: string }>(value: T) {
  return { id: value.id, contentHash: value.contentHash };
}
