import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GradeResult,
  TaskAttemptArtifact,
  TaskAttemptResult,
  TaskDataRecord,
} from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { appDataDir } from "../apps/server/src/paths.js";
import {
  materializeTasksetWorkFixture,
  validateTasksetWorkFixtureOutput,
  type TasksetWorkFixtureKind,
} from "../tests/helpers/taskset-work-fixtures.js";

const SERVER_URL =
  process.env.OPENPOND_APP_SERVER_URL?.trim()
  || "http://127.0.0.1:17874";
const STORE_DIR = process.env.OPENPOND_APP_HOME?.trim() || appDataDir();
const TOKEN_PATH = path.join(STORE_DIR, "token");
const RUN_LABEL = "20260730_openpond_chat_schema_v1";
const OUTPUT_PATH = path.resolve(
  "output",
  "taskset-work-live-acceptance",
  `${RUN_LABEL}.json`,
);
const MODEL = {
  providerId: "openpond",
  modelId: "openpond-chat",
} as const;
const REPETITIONS = 2;
const FIXTURE_KINDS = [
  "multi_document",
  "portability",
] satisfies TasksetWorkFixtureKind[];

type StoredExecution = {
  attempt: TaskAttemptResult;
  grade: GradeResult;
  artifacts: TaskAttemptArtifact[];
};

const tasksets = new Map<
  TasksetWorkFixtureKind,
  Awaited<ReturnType<typeof materializeTasksetWorkFixture>>
>();
const materializationStore = new SqliteStore(STORE_DIR);
try {
  for (const kind of FIXTURE_KINDS) {
    const materialized = await materializeTasksetWorkFixture(STORE_DIR, kind);
    await materializationStore.upsertTaskset(materialized.taskset);
    tasksets.set(kind, materialized);
  }
} finally {
  await materializationStore.close();
}

const token = (await readFile(TOKEN_PATH, "utf8")).trim();
if (!token) throw new Error("The local OpenPond capability token is empty.");

const results = [];
for (const kind of FIXTURE_KINDS) {
  const materialized = tasksets.get(kind);
  if (!materialized) throw new Error(`Fixture ${kind} was not materialized.`);
  const task = materialized.taskset.tasks[0];
  if (!task) throw new Error(`Fixture ${kind} has no task.`);

  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    const resultId =
      `attempt_${kind}_openpond_chat_${RUN_LABEL}_${repetition}`;
    const stored = await storedExecution(
      materialized.taskset.id,
      resultId,
    );
    const reusable =
      stored?.attempt.infrastructureError === null ? stored : null;
    const execution = reusable ?? await executeAttempt({
      token,
      tasksetId: materialized.taskset.id,
      taskId: task.id,
      repetition,
      resultId,
    });
    const validation = await validateArtifacts({
      kind,
      task,
      artifacts: execution.artifacts,
    });
    const costEvidence = asRecord(execution.attempt.metadata.costEvidence);
    const cleanupObserved = await cleanupSucceeded(execution.artifacts);
    const accepted =
      execution.attempt.infrastructureError === null
      && execution.attempt.output.outputsPassed === true
      && execution.grade.passed
      && execution.grade.rewardEligible
      && cleanupObserved
      && validation.every((item) => item.passed);
    const receipt = {
      fixture: kind,
      repetition,
      reused: reusable !== null,
      resultId,
      tasksetId: materialized.taskset.id,
      tasksetHash: materialized.taskset.contentHash,
      taskId: task.id,
      model: MODEL,
      accepted,
      attempt: {
        startedAt: execution.attempt.startedAt,
        completedAt: execution.attempt.completedAt,
        latencyMs: execution.attempt.latencyMs,
        costUsd: execution.attempt.costUsd,
        infrastructureError: execution.attempt.infrastructureError,
        outputsPassed: execution.attempt.output.outputsPassed === true,
        toolFailureCount: numericValue(
          execution.attempt.output.toolFailureCount,
        ),
        status: execution.attempt.metadata.status ?? null,
        sessionId: execution.attempt.metadata.sessionId ?? null,
        costEvidence: {
          providerInferenceUsd:
            numericValue(costEvidence.providerInferenceUsd),
          workRuntimeUsd: numericValue(costEvidence.workRuntimeUsd),
          workRuntimeBillableUsd:
            numericValue(costEvidence.workRuntimeBillableUsd),
          workRuntimeSimulatedUsd:
            numericValue(costEvidence.workRuntimeSimulatedUsd),
          combinedUsd: numericValue(costEvidence.combinedUsd),
          workReceiptIds: stringArray(costEvidence.workReceiptIds),
          workDurationSeconds:
            numericValue(costEvidence.workDurationSeconds),
          settlementModes: stringArray(costEvidence.settlementModes),
        },
      },
      grade: {
        id: execution.grade.id,
        score: execution.grade.score,
        passed: execution.grade.passed,
        rewardEligible: execution.grade.rewardEligible,
        failureClass: execution.grade.failureClass,
      },
      outputs: validation,
      cleanupObserved,
    };
    results.push(receipt);
    await writeReceipt(results);
    process.stdout.write(
      `${kind} repetition ${repetition + 1}/${REPETITIONS}: `
      + `${accepted ? "accepted" : "failed"}, `
      + `latency ${execution.attempt.latencyMs} ms, `
      + `cost ${execution.attempt.costUsd ?? "unreported"} USD\n`,
    );
  }
}

const failed = results.filter((result) => !result.accepted);
if (failed.length) {
  throw new Error(
    `${failed.length} of ${results.length} capped Work repetitions failed acceptance.`,
  );
}
process.stdout.write(
  `All ${results.length} capped Work repetitions passed. `
  + `Receipt: ${OUTPUT_PATH}\n`,
);

async function executeAttempt(input: {
  token: string;
  tasksetId: string;
  taskId: string;
  repetition: number;
  resultId: string;
}): Promise<StoredExecution> {
  const response = await fetch(
    `${SERVER_URL}/v1/training/tasksets/`
      + `${encodeURIComponent(input.tasksetId)}/attempts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskId: input.taskId,
        model: MODEL,
        seed: 17,
        attempt: input.repetition,
        resultId: input.resultId,
        sampling: {
          maxOutputTokens: 4_096,
          temperature: 0,
          topP: 1,
        },
      }),
      signal: AbortSignal.timeout(240_000),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000);
    throw new Error(
      `Taskset Work attempt returned HTTP ${response.status}: ${detail}`,
    );
  }
  const body = asRecord(await response.json());
  return {
    attempt: body.attempt as TaskAttemptResult,
    grade: body.grade as GradeResult,
    artifacts: Array.isArray(body.artifacts)
      ? body.artifacts as TaskAttemptArtifact[]
      : [],
  };
}

async function storedExecution(
  tasksetId: string,
  resultId: string,
): Promise<StoredExecution | null> {
  const store = new SqliteStore(STORE_DIR);
  try {
    const attempt = (await store.listTaskAttempts(tasksetId)).find(
      (candidate) => candidate.id === resultId,
    );
    if (!attempt) return null;
    const grade = (await store.listGradeResultsForTaskset(tasksetId))
      .filter((candidate) => candidate.attemptId === resultId)
      .at(-1);
    if (!grade) return null;
    return {
      attempt,
      grade,
      artifacts: await store.listTaskAttemptArtifacts({
        attemptId: resultId,
      }),
    };
  } finally {
    await store.close();
  }
}

async function validateArtifacts(input: {
  kind: TasksetWorkFixtureKind;
  task: TaskDataRecord;
  artifacts: TaskAttemptArtifact[];
}) {
  const results = [];
  for (const requiredOutput of input.task.requiredOutputs ?? []) {
    const artifact = input.artifacts
      .filter(
      (candidate) =>
        candidate.kind === "output_artifact"
        && asRecord(candidate.metadata).requiredOutputPath
          === requiredOutput.path,
      )
      .sort((left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt)
      )
      .at(-1);
    if (!artifact) {
      results.push({
        path: requiredOutput.path,
        passed: false,
        detail: "Required output artifact was not persisted.",
        sha256: null,
        sizeBytes: null,
      });
      continue;
    }
    const bytes = await readFile(artifact.path);
    const observedSha256 = createHash("sha256").update(bytes).digest("hex");
    const privateValidation = await validateTasksetWorkFixtureOutput({
      kind: input.kind,
      requiredOutput,
      artifactPath: artifact.path,
    });
    const hashPassed =
      observedSha256 === artifact.sha256
      && bytes.byteLength === artifact.sizeBytes;
    results.push({
      path: requiredOutput.path,
      passed: hashPassed && privateValidation.passed,
      detail: hashPassed
        ? privateValidation.detail
        : "Persisted artifact hash or size did not match readback.",
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    });
  }
  return results;
}

async function cleanupSucceeded(
  artifacts: TaskAttemptArtifact[],
): Promise<boolean> {
  const traceArtifact = artifacts
    .filter((artifact) => artifact.kind === "runtime_trace")
    .sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt)
    )
    .at(-1);
  if (!traceArtifact) return false;
  const trace = asRecord(
    JSON.parse(await readFile(traceArtifact.path, "utf8")),
  );
  const steps = Array.isArray(trace.steps) ? trace.steps.map(asRecord) : [];
  return steps.some(
    (step) => step.kind === "cleanup" && step.ok === true,
  );
}

async function writeReceipt(
  attempts: Array<Record<string, unknown>>,
): Promise<void> {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const providerInferenceUsd = sum(
    attempts.map((result) =>
      numericValue(
        asRecord(asRecord(result.attempt).costEvidence).providerInferenceUsd,
      ) ?? 0
    ),
  );
  const workRuntimeUsd = sum(
    attempts.map((result) =>
      numericValue(
        asRecord(asRecord(result.attempt).costEvidence).workRuntimeUsd,
      ) ?? 0
    ),
  );
  const payload = {
    schemaVersion: "openpond.tasksetWorkLiveAcceptance.v1",
    runLabel: RUN_LABEL,
    serverUrl: SERVER_URL,
    model: MODEL,
    fixtureKinds: FIXTURE_KINDS,
    repetitionsPerFixture: REPETITIONS,
    attempted: attempts.length,
    accepted: attempts.filter((result) => result.accepted === true).length,
    providerInferenceUsd,
    workRuntimeUsd,
    combinedRecordedUsd: sum(
      attempts.map((result) =>
        numericValue(asRecord(result.attempt).costUsd) ?? 0
      ),
    ),
    attempts,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sum(values: number[]): number {
  return Number(
    values.reduce((total, value) => total + value, 0).toFixed(12),
  );
}
