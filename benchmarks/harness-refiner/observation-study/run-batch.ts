import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GradeResultSchema,
  type ChatModelRef,
  type HarnessRefinerOutcome,
  type RefinementTriggerDecision,
  type Session,
  type TaskAttemptArtifact,
  type TaskAttemptResult,
} from "@openpond/contracts";
import {
  ArtifactManifestSchema,
  AttemptReceiptSchema,
  CanonicalRolloutRecordSchema,
  RewardReceiptSchema,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import { streamOpenPondHostedChatTurn } from "@openpond/runtime";

import { ensureLocalHarnessRunOverlay } from "../../../apps/server/src/harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from "../../../apps/server/src/harness/local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "../../../apps/server/src/harness/local-harness-refiner-worker.js";
import { loadSelectedLocalHarnessRuntime } from "../../../apps/server/src/harness/local-harness-skill-runtime.js";
import { SqliteStore } from "../../../apps/server/src/store/store.js";
import { persistCanonicalEvaluationEvidence } from "../../../apps/server/src/training/canonical-evaluation-persistence.js";
import { benchmarkRefinerRewardPacket } from "../../../apps/server/src/training/harness-refiner-benchmark-refiner-stage.js";
import { createLocalTasksetWorkRuntime } from "../../../apps/server/src/training/local-taskset-work-runtime.js";
import { compileDesktopHarnessContext } from "../../../apps/server/src/training/portable-evals-adapter.js";
import {
  runTasksetWorkAttempt,
  type TasksetWorkModelStream,
} from "../../../apps/server/src/training/taskset-work-attempt-runner.js";
import { event } from "../../../apps/server/src/utils.js";
import {
  buildObservationStudyTaskset,
  loadObservationStudyTasks,
  taskId,
  type ObservationStudyTask,
} from "./study-taskset.js";

const SERVER_URL = process.env.OPENPOND_APP_SERVER_URL?.trim() || "http://127.0.0.1:17874";
const STORE_DIR = process.env.OPENPOND_APP_HOME?.trim();
const OUTPUT_PATH = path.resolve(
  process.env.OPENPOND_REFINER_OBSERVATION_OUTPUT?.trim()
    || path.join("output", "harness-refiner-observation-study", "2026-08-17", "canonical-50.json"),
);
const MODEL: ChatModelRef = { providerId: "openpond", modelId: "openpond-chat" };
const ORDER_SEED = "refiner-observation-2026-08-17-v2";
const GATE_ORDER = [3, 49, 45, 22, 11];
const RESUME = process.env.OPENPOND_REFINER_OBSERVATION_RESUME === "1";

if (!STORE_DIR) throw new Error("OPENPOND_APP_HOME is required for an isolated local observation run.");

const token = (await readFile(path.join(STORE_DIR, "token"), "utf8")).trim();
if (!token) throw new Error("The isolated OpenPond capability token is empty.");
const store = new SqliteStore(STORE_DIR);

try {
  const tasks = await loadObservationStudyTasks();
  const taskset = buildObservationStudyTaskset(tasks);
  await store.upsertTaskset(taskset);
  const orderedTasks = selectTasks(tasks);
  const initialRuntime = await requireSelectedRuntime();
  await store.setHarnessBackgroundReviewSettings({
    workspaceId: initialRuntime.workspace.id,
    enabled: true,
    updatedAt: new Date().toISOString(),
  });
  const runtime = createLocalTasksetWorkRuntime({
    storeDir: STORE_DIR,
    deviceId: `observation-${process.pid}`,
    createSession: (payload) => api<Session>("/v1/sessions", { method: "POST", body: payload }),
    getSession: async (sessionId) => {
      const session = await store.getSession(sessionId);
      if (!session) throw new Error(`Local Work session ${sessionId} was not found.`);
      return session;
    },
    runtimeEventsForSession: (sessionId) => store.runtimeEventsForSession(sessionId),
  });
  const receipt = await loadOrCreateReceipt(initialRuntime);
  receipt.selectedTaskIds = orderedTasks.map((task) => task.id);
  const completedIds = new Set(receipt.tasks.map((task) => task.promptId));
  const pendingTasks = orderedTasks.filter((task) => !completedIds.has(task.id));
  if (pendingTasks.length) {
    receipt.completedAt = null;
    receipt.updatedAt = new Date().toISOString();
    await persistReceipt(receipt);
  }

  for (const [index, studyTask] of pendingTasks.entries()) {
    const sequence = completedIds.size + index + 1;
    process.stdout.write(`TASK_START ${sequence}/${orderedTasks.length} ${taskId(studyTask.id)} local\n`);
    const admittedRuntime = await loadFreshSelectedRuntime();
    const task = taskset.tasks.find((candidate) => candidate.id === taskId(studyTask.id));
    if (!task) throw new Error(`Task ${studyTask.id} is missing from the observation Taskset.`);
    let canonical = await recoverCanonicalEvidence(task.id);
    if (canonical) process.stdout.write(`TASK_RECOVER ${taskId(studyTask.id)} canonical-attempt=${canonical.attempt.id}\n`);
    if (!canonical) canonical = await executeCanonicalAttempt({ taskset, task, studyTask, admittedRuntime, runtime });
    const attempt = canonical.attempt;
    const output = recordValue(attempt.output);
    const passed = canonical.rewardReceipt.passed;
    const boundaryStore = new SqliteStore(STORE_DIR);
    let boundary: Awaited<ReturnType<typeof materializeRefinerBoundary>>;
    let detection: Awaited<ReturnType<typeof recordLocalHarnessImprovementBoundary>>;
    let outcome: HarnessRefinerOutcome | null = null;
    const refinerUsage: unknown[] = [];
    let afterRuntime: SelectedRuntime;
    try {
      boundary = await materializeRefinerBoundary({
        store: boundaryStore,
        attempt,
        admittedRuntime,
        promptId: studyTask.id,
        rewardPacket: benchmarkRefinerRewardPacket({
          attempt,
          artifactManifest: canonical.artifactManifest,
          rewardReceipt: canonical.rewardReceipt,
          artifactCount: canonical.artifacts.length,
        }),
      });
      detection = await recordLocalHarnessImprovementBoundary({
        store: boundaryStore,
        session: boundary.session,
        turn: boundary.turn,
        boundaryKind: "turn_completed",
      });
      if (detection?.trigger.decision === "queue_refiner") {
        const result = await runLocalHarnessRefinerWorker({
          store: boundaryStore,
          storeDir: STORE_DIR,
          trigger: detection.trigger,
          signal: new AbortController().signal,
          stream: async function* ({ messages, signal }) {
            for await (const delta of streamOpenPondHostedChatTurn({
              model: MODEL.modelId,
              messages,
              requestId: `observation-refiner:${detection!.trigger.id}`,
              reasoningEffort: "low",
              maxTokens: 4_096,
              signal,
            })) {
              if (delta.type === "text_delta" && delta.text) yield { text: delta.text };
              if (delta.type === "usage") refinerUsage.push(delta.usage);
            }
          },
        });
        outcome = result.outcome;
      }
      afterRuntime = await requireSelectedRuntime(boundaryStore);
    } finally {
      await boundaryStore.close();
    }
    receipt.tasks.push({
      promptId: studyTask.id,
      outputKind: studyTask.outputKind,
      sessionId: boundary.session.id,
      turnId: boundary.turn.id,
      attemptId: attempt.id,
      admittedHarness: releaseRef(admittedRuntime),
      resultingHarness: releaseRef(afterRuntime),
      canonical: {
        attemptReceipt: canonical.attemptReceipt,
        artifactManifest: canonical.artifactManifest,
        rewardReceipt: canonical.rewardReceipt,
        rolloutRecord: canonical.rolloutRecord,
      },
      structural: {
        passed,
        outputPresent: typeof output.text === "string" && output.text.trim().length > 0,
        outputsPassed: output.outputsPassed === true,
        artifactCount: canonical.artifacts.length,
      },
      foregroundUsage: attempt.metadata.usage ?? [],
      trigger: detection?.trigger ?? null,
      outcome,
      refinerUsage,
    });
    receipt.updatedAt = new Date().toISOString();
    receipt.finalHarness = releaseRef(afterRuntime);
    await persistReceipt(receipt);
    process.stdout.write(
      `TASK_COMPLETE ${taskId(studyTask.id)} reward=${canonical.rewardReceipt.reward ?? "unscorable"} `
      + `refiner=${classifyOutcome(outcome, detection?.trigger ?? null)} `
      + `foreground_tokens=${usageTotal(attempt.metadata.usage)} refiner_tokens=${usageTotal(refinerUsage)}\n`,
    );
  }
  receipt.completedAt = receipt.tasks.length === orderedTasks.length ? new Date().toISOString() : null;
  receipt.updatedAt = new Date().toISOString();
  receipt.finalHarness = releaseRef(await requireSelectedRuntime());
  await persistReceipt(receipt);
  process.stdout.write(`BATCH_COMPLETE ${receipt.tasks.length}/${orderedTasks.length} local receipt=${OUTPUT_PATH}\n`);
} finally {
  await store.close();
}

type SelectedRuntime = NonNullable<Awaited<ReturnType<typeof loadSelectedLocalHarnessRuntime>>>;
type CanonicalEvidence = Awaited<ReturnType<typeof persistCanonicalEvaluationEvidence>>;
type ObservationReceipt = {
  schemaVersion: "openpond.harnessRefinerObservationBatch.v3";
  study: string;
  execution: "desktop_local_work";
  orderSeed: string;
  selectedTaskIds: number[];
  runtime: { model: ChatModelRef; serverUrl: string; workspace: "local" };
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  initialHarness: ReturnType<typeof releaseRef>;
  finalHarness: ReturnType<typeof releaseRef>;
  tasks: Array<Record<string, unknown> & { promptId: number }>;
};

async function requireSelectedRuntime(inputStore: SqliteStore = store): Promise<SelectedRuntime> {
  const runtime = await loadSelectedLocalHarnessRuntime(inputStore);
  if (!runtime) throw new Error("A selected Local Harness release is required.");
  return runtime;
}

async function loadFreshSelectedRuntime(): Promise<SelectedRuntime> {
  const freshStore = new SqliteStore(STORE_DIR!);
  try {
    return await requireSelectedRuntime(freshStore);
  } finally {
    await freshStore.close();
  }
}

async function recoverCanonicalEvidence(sourceTaskId: string): Promise<CanonicalEvidence | null> {
  const attempts = await store.listTaskAttempts("harness-refiner-observation-50-v2");
  const attempt = attempts.filter((candidate) =>
    candidate.taskId === sourceTaskId && candidate.metadata.portableRewardReceipt
  ).at(-1);
  if (!attempt) return null;
  const artifacts = await store.listTaskAttemptArtifacts({ attemptId: attempt.id });
  return {
    attempt,
    artifacts,
    attemptReceipt: AttemptReceiptSchema.parse(attempt.metadata.portableAttemptReceipt),
    artifactManifest: ArtifactManifestSchema.parse(attempt.metadata.portableArtifactManifest),
    rewardReceipt: RewardReceiptSchema.parse(attempt.metadata.portableRewardReceipt),
    rolloutRecord: CanonicalRolloutRecordSchema.parse(attempt.metadata.portableCanonicalRollout),
  };
}

async function executeCanonicalAttempt(input: {
  taskset: ReturnType<typeof buildObservationStudyTaskset>;
  task: ReturnType<typeof buildObservationStudyTaskset>["tasks"][number];
  studyTask: ObservationStudyTask;
  admittedRuntime: SelectedRuntime;
  runtime: ReturnType<typeof createLocalTasksetWorkRuntime>;
}): Promise<CanonicalEvidence> {
  const context = compileDesktopHarnessContext({
    taskset: input.taskset,
    selectedTask: input.task,
    releasedHarness: {
      agentSnapshot: input.admittedRuntime.release.agentSnapshot,
      harnessRelease: input.admittedRuntime.release.harnessRelease,
    },
    reasoningEffort: "low",
    model: MODEL,
  });
  const attempt = await runTasksetWorkAttempt({
    store,
    storeDir: STORE_DIR!,
    taskset: input.taskset,
    task: input.task,
    model: MODEL,
    reasoningEffort: "low",
    seed: 17,
    attempt: 0,
    sampling: { maxOutputTokens: 8_192, temperature: 0, topP: 1 },
    stream: hostedModelStream,
    runtime: input.runtime,
    harnessInstructionContext: input.admittedRuntime.instructionContext,
    harnessCapabilityReceipt: {
      execution: "desktop_local_work",
      harnessRelease: input.admittedRuntime.release.harnessRelease,
      agentSnapshot: input.admittedRuntime.release.agentSnapshot,
    },
  });
  const passed = structuralPass(attempt, input.studyTask);
  const infrastructureFailure = attempt.infrastructureError !== null;
  const feedback = passed
    ? "The requested output was structurally materialized."
    : infrastructureFailure
      ? "The local execution environment did not produce a scorable attempt."
      : "The requested output was not structurally materialized.";
  const grade = GradeResultSchema.parse({
    schemaVersion: "openpond.gradeResult.v1",
    id: `grade-${attempt.id}`,
    attemptId: attempt.id,
    graderSetHash: contentHash(input.taskset.graders),
    score: infrastructureFailure ? null : passed ? 1 : 0,
    passed,
    components: [{
      graderId: "structural-output-verifier",
      graderVersion: "1",
      score: passed ? 1 : 0,
      passed,
      hardGate: true,
      rewardEligible: !infrastructureFailure,
      feedback,
      evidenceRefs: [],
      judge: null,
      calibrationStatus: "not_applicable",
    }],
    failureClass: infrastructureFailure ? "infrastructure_failure" : passed ? null : "grader_failure",
    feedback: passed ? [] : [feedback],
    rewardEligible: !infrastructureFailure,
    createdAt: attempt.completedAt,
  });
  await store.saveGradeResult(grade);
  const artifacts: TaskAttemptArtifact[] = await store.listTaskAttemptArtifacts({ attemptId: attempt.id });
  return persistCanonicalEvaluationEvidence({
    store,
    storeDir: STORE_DIR!,
    taskset: input.taskset,
    task: input.task,
    context,
    attempt,
    grade,
    artifacts,
  });
}

function selectTasks(tasks: ObservationStudyTask[]): ObservationStudyTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const order = [...GATE_ORDER, ...tasks.map((task) => task.id).filter((id) => !GATE_ORDER.includes(id))];
  const requested = (process.env.OPENPOND_REFINER_OBSERVATION_TASK_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isInteger(value));
  const selectedIds = requested.length
    ? order.filter((id) => requested.includes(id))
    : order.slice(0, boundedMaximum());
  const selected = selectedIds.map((id) => byId.get(id)).filter((task): task is ObservationStudyTask => Boolean(task));
  if (!selected.length) throw new Error("No observation tasks were selected.");
  return selected;
}

function boundedMaximum(): number {
  const value = Number(process.env.OPENPOND_REFINER_OBSERVATION_MAX_TASKS ?? "50");
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("OPENPOND_REFINER_OBSERVATION_MAX_TASKS must be an integer from 1 through 50.");
  }
  return value;
}

async function loadOrCreateReceipt(runtime: SelectedRuntime): Promise<ObservationReceipt> {
  if (RESUME) {
    const parsed = JSON.parse(await readFile(OUTPUT_PATH, "utf8")) as ObservationReceipt;
    if (parsed.schemaVersion !== "openpond.harnessRefinerObservationBatch.v3" || parsed.orderSeed !== ORDER_SEED) {
      throw new Error("The requested resume receipt is not compatible with this observation protocol.");
    }
    return parsed;
  }
  const now = new Date().toISOString();
  const receipt: ObservationReceipt = {
    schemaVersion: "openpond.harnessRefinerObservationBatch.v3",
    study: "harness-refiner-50-prompt-structural-observation-v2",
    execution: "desktop_local_work",
    orderSeed: ORDER_SEED,
    selectedTaskIds: selectTasks(await loadObservationStudyTasks()).map((task) => task.id),
    runtime: { model: MODEL, serverUrl: SERVER_URL, workspace: "local" },
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    initialHarness: releaseRef(runtime),
    finalHarness: releaseRef(runtime),
    tasks: [],
  };
  await persistReceipt(receipt);
  return receipt;
}

function structuralPass(attempt: TaskAttemptResult, task: ObservationStudyTask): boolean {
  if (attempt.infrastructureError) return false;
  if (task.requiredOutput) return attempt.output.outputsPassed === true;
  return typeof attempt.output.text === "string" && attempt.output.text.trim().length > 0;
}

async function materializeRefinerBoundary(input: {
  store: SqliteStore;
  attempt: TaskAttemptResult;
  admittedRuntime: SelectedRuntime;
  promptId: number;
  rewardPacket: Record<string, unknown>;
}) {
  const sessionId = stringMetadata(input.attempt.metadata, "sessionId");
  const turnId = stringMetadata(input.attempt.metadata, "turnId");
  if (!sessionId || !turnId) throw new Error(`Prompt ${input.promptId} has no local session boundary.`);
  const session = await input.store.updateSession(sessionId, (current) => ({
    ...current,
    metadata: {
      ...current.metadata,
      harnessRefinerObservationStudy: true,
      observationPromptId: input.promptId,
      orderSeed: ORDER_SEED,
      execution: "desktop_local_work",
    },
  }));
  const originalTurn = await input.store.getTurn(turnId);
  if (!session || !originalTurn) throw new Error(`Prompt ${input.promptId} local boundary is missing.`);
  const overlay = await ensureLocalHarnessRunOverlay({
    store: input.store,
    runId: session.id,
    workspace: input.admittedRuntime.workspace,
    harnessRelease: releaseRef(input.admittedRuntime),
    admittedAt: input.attempt.startedAt,
  });
  const turn = await input.store.updateTurn(turnId, (current) => ({
    ...current,
    harnessSnapshot: {
      schemaVersion: "openpond.harnessTurnSnapshot.v1",
      workspaceId: input.admittedRuntime.workspace.id,
      workspaceRevision: input.admittedRuntime.workspace.revision,
      sourceRevision: input.admittedRuntime.workspace.sourceRevision,
      channelName: input.admittedRuntime.workspace.currentChannel.name,
      channelRevision: input.admittedRuntime.workspace.currentChannel.revision,
      harnessRelease: overlay.baseHarnessRelease,
      overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
    },
  }));
  if (!turn) throw new Error(`Prompt ${input.promptId} local turn could not be updated.`);
  const reward = recordValue(input.rewardPacket.rewardReceipt);
  const passed = reward.status === "scored" && reward.passed === true;
  const evidence = JSON.stringify(input.rewardPacket);
  await input.store.appendRuntimeEvent(event({
    sessionId,
    turnId,
    name: "diagnostic",
    source: "server",
    action: "taskset_grade",
    status: passed ? "completed" : "failed",
    output: evidence,
    error: passed ? undefined : evidence,
    data: { result: { output: evidence, passed, status: reward.status, reward: reward.reward } },
  }));
  return { session, turn };
}

async function* hostedModelStream(
  input: Parameters<TasksetWorkModelStream>[0],
): ReturnType<TasksetWorkModelStream> {
  for await (const delta of streamOpenPondHostedChatTurn({
    model: input.model.modelId,
    messages: input.messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
    requestId: input.requestId,
    reasoningEffort: input.reasoningEffort === "none" ? undefined : input.reasoningEffort ?? undefined,
    maxTokens: input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    signal: input.signal,
  })) {
    if (delta.type === "text_delta" && delta.text) yield { text: delta.text };
    if (delta.type === "tool_call_delta") yield { toolCalls: delta.toolCalls };
    if (delta.type === "usage") yield { usage: delta.usage };
    if (delta.type === "continuation") yield { continuation: delta.continuation };
  }
}

function classifyOutcome(
  outcome: HarnessRefinerOutcome | null,
  trigger: RefinementTriggerDecision | null,
): string {
  if (!outcome) return trigger?.decision ?? "not_reviewed";
  if (outcome.metadata.routed === true) {
    return `route_${typeof outcome.metadata.route === "string" ? outcome.metadata.route : "unknown"}`;
  }
  return outcome.decision;
}

function releaseRef(runtime: SelectedRuntime) {
  return {
    id: runtime.release.harnessRelease.id,
    contentHash: runtime.release.harnessRelease.contentHash,
  };
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function usageTotal(value: unknown): number {
  const usages = Array.isArray(value) ? value : value ? [value] : [];
  return usages.reduce((total, usage) => {
    const record = recordValue(usage);
    const reported = numeric(record.total_tokens ?? record.totalTokens);
    return total + (reported || numeric(record.input_tokens ?? record.prompt_tokens ?? record.promptTokens)
      + numeric(record.output_tokens ?? record.completion_tokens ?? record.completionTokens));
  }, 0);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function persistReceipt(receipt: ObservationReceipt): Promise<void> {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

async function api<T>(pathname: string, input: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${SERVER_URL}${pathname}`, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${text.slice(0, 4_000)}`);
  return JSON.parse(text) as T;
}
