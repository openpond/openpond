import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ChatModelRef,
  HarnessRefinerOutcome,
  RefinementTriggerDecision,
  Session,
  TaskDataRecord,
  Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { streamOpenPondHostedChatTurn } from "@openpond/runtime";

import { ensureLocalHarnessRunOverlay } from "../../../apps/server/src/harness/local-harness-run-overlay.js";
import { recordLocalHarnessImprovementBoundary } from "../../../apps/server/src/harness/local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "../../../apps/server/src/harness/local-harness-refiner-worker.js";
import { loadSelectedLocalHarnessRuntime } from "../../../apps/server/src/harness/local-harness-skill-runtime.js";
import { SqliteStore } from "../../../apps/server/src/store/store.js";
import { createLocalTasksetWorkRuntime } from "../../../apps/server/src/training/local-taskset-work-runtime.js";
import {
  runTasksetWorkAttempt,
  type TasksetWorkModelStream,
} from "../../../apps/server/src/training/taskset-work-attempt-runner.js";
import { event } from "../../../apps/server/src/utils.js";

const ROOT = path.resolve(import.meta.dirname);
const FIXTURE_ROOT = path.join(ROOT, "fixtures");
const SERVER_URL = process.env.OPENPOND_APP_SERVER_URL?.trim() || "http://127.0.0.1:17914";
const STORE_DIR = process.env.OPENPOND_APP_HOME?.trim();
const OUTPUT_PATH = path.resolve(
  process.env.OPENPOND_REFINER_OBSERVATION_OUTPUT?.trim()
    || path.join("output", "harness-refiner-observation-study", "2026-08-12", "local-batch-01.json"),
);
const MODEL: ChatModelRef = { providerId: "openpond", modelId: "openpond-chat" };
const ORDER_SEED = "refiner-observation-2026-08-12-v1";
const TASKSET_ID = "harness-refiner-observation-local-batch-01";
const WORK_TOOL_NAMES = [
  "work_environment",
  "work_list_files",
  "work_read_file",
  "work_write_file",
  "work_edit_file",
  "work_exec",
  "work_save_output",
  "work_stop",
];

if (!STORE_DIR) throw new Error("OPENPOND_APP_HOME is required for an isolated local observation run.");

type StudyTask = {
  id: number;
  prompt: string;
  fixtures: string[];
  expectedOutputKind: "pdf" | "xlsx" | "html" | "text";
};

const BATCH_ONE: StudyTask[] = [
  {
    id: 3,
    prompt: "Create an accessible PDF welcome packet for volunteers at a community food pantry. It should cover arrival, parking, check-in, clothing, safety, shift responsibilities, accessibility accommodations, and who to contact. Use the attached operational notes, add a clear checklist, and make the document easy to scan on a phone.",
    fixtures: ["prompt-003-food-pantry-operational-notes.md"],
    expectedOutputKind: "pdf",
  },
  {
    id: 49,
    prompt: "Create a resident notice about a six-hour building water shutdown. Include the date and exact time, affected areas, reason for the work, preparation steps, accessibility assistance, emergency contact, and what residents should do when service returns. Make it suitable for both email and lobby posting.",
    fixtures: [],
    expectedOutputKind: "text",
  },
  {
    id: 45,
    prompt: "Review the attached customer-feedback export and produce a product-discovery summary. Group related problems without merging materially different requests, quantify recurring themes, include representative anonymized examples, identify gaps in the evidence, and propose the next five customer interviews.",
    fixtures: ["prompt-045-customer-feedback.csv"],
    expectedOutputKind: "text",
  },
  {
    id: 22,
    prompt: "Create a standalone HTML operations dashboard using the attached fulfillment data. Show daily order volume, late shipments, return rate, and warehouse performance with accessible CSS-based charts. Include filters for warehouse and date range and provide a usable empty state.",
    fixtures: ["prompt-022-fulfillment-data.csv"],
    expectedOutputKind: "html",
  },
  {
    id: 11,
    prompt: "Turn the attached event requirements and employee availability into an Excel staffing schedule. Assign shifts without overlapping an employee, flag uncovered roles, calculate hours by employee, and include a printable daily schedule for each event day.",
    fixtures: [
      "prompt-011-event-requirements.csv",
      "prompt-011-employee-availability.csv",
    ],
    expectedOutputKind: "xlsx",
  },
];

const requestedTaskIds = new Set(
  (process.env.OPENPOND_REFINER_OBSERVATION_TASK_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value)),
);
const selectedTasks = requestedTaskIds.size > 0
  ? BATCH_ONE.filter((task) => requestedTaskIds.has(task.id))
  : BATCH_ONE;
if (selectedTasks.length === 0) {
  throw new Error("OPENPOND_REFINER_OBSERVATION_TASK_IDS did not match a batch task.");
}

const token = (await readFile(path.join(STORE_DIR, "token"), "utf8")).trim();
if (!token) throw new Error("The isolated OpenPond capability token is empty.");
const store = new SqliteStore(STORE_DIR);

try {
  const selectedHarness = await loadSelectedLocalHarnessRuntime(store);
  if (!selectedHarness) throw new Error("A selected Local Harness release is required.");
  await store.setHarnessBackgroundReviewSettings({
    workspaceId: selectedHarness.workspace.id,
    enabled: true,
    updatedAt: new Date().toISOString(),
  });
  const taskset = await localObservationTaskset(selectedTasks);
  const localRuntime = createLocalTasksetWorkRuntime({
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
  const receipt: Record<string, unknown> = {
    schemaVersion: "openpond.harnessRefinerObservationBatch.v2",
    study: "2026-08-11-harness-refiner-50-prompt-observation-study",
    execution: "desktop_local_work",
    batch: 1,
    orderSeed: ORDER_SEED,
    batchTaskIds: selectedTasks.map((task) => task.id),
    runtime: { model: MODEL, serverUrl: SERVER_URL, workspace: "local" },
    startedAt: new Date().toISOString(),
    initialHarness: releaseRef(selectedHarness),
    tasks: [],
  };
  await persistReceipt(receipt);

  for (const [batchIndex, studyTask] of selectedTasks.entries()) {
    process.stdout.write(
      `TASK_START ${batchIndex + 1}/${selectedTasks.length} prompt-${String(studyTask.id).padStart(3, "0")} local\n`,
    );
    const task = taskset.tasks.find((candidate) => candidate.id === taskId(studyTask.id));
    if (!task) throw new Error(`Local Taskset task ${studyTask.id} is missing.`);
    const attempt = await runTasksetWorkAttempt({
      store,
      storeDir: STORE_DIR,
      taskset,
      task,
      model: MODEL,
      reasoningEffort: "low",
      seed: 17,
      attempt: 0,
      sampling: { maxOutputTokens: 8_192, temperature: 0, topP: 1 },
      stream: hostedModelStream,
      runtime: localRuntime,
      harnessInstructionContext: selectedHarness.instructionContext,
      harnessCapabilityReceipt: {
        execution: "desktop_local_work",
        harnessRelease: selectedHarness.release.harnessRelease,
        agentSnapshot: selectedHarness.release.agentSnapshot,
      },
    });
    const sessionId = stringMetadata(attempt.metadata, "sessionId");
    const turnId = stringMetadata(attempt.metadata, "turnId");
    if (!sessionId || !turnId) throw new Error(`Prompt ${studyTask.id} has no local session boundary.`);
    const storedSession = await store.getSession(sessionId);
    const originalTurn = await store.getTurn(turnId);
    if (!storedSession || !originalTurn) throw new Error(`Prompt ${studyTask.id} local boundary is missing.`);
    const session = await store.updateSession(sessionId, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        harnessRefinerObservationStudy: true,
        observationBatch: 1,
        observationPromptId: studyTask.id,
        orderSeed: ORDER_SEED,
        execution: "desktop_local_work",
      },
    }));
    if (!session) throw new Error(`Prompt ${studyTask.id} local session could not be updated.`);
    const overlay = await ensureLocalHarnessRunOverlay({
      store,
      runId: session.id,
      workspace: selectedHarness.workspace,
      harnessRelease: {
        id: selectedHarness.release.harnessRelease.id,
        contentHash: selectedHarness.release.harnessRelease.contentHash,
      },
      admittedAt: attempt.startedAt,
    });
    const turn = await store.updateTurn(turnId, (current) => ({
      ...current,
      harnessSnapshot: {
        schemaVersion: "openpond.harnessTurnSnapshot.v1",
        workspaceId: selectedHarness.workspace.id,
        workspaceRevision: selectedHarness.workspace.revision,
        sourceRevision: selectedHarness.workspace.sourceRevision,
        channelName: selectedHarness.workspace.currentChannel.name,
        channelRevision: selectedHarness.workspace.currentChannel.revision,
        harnessRelease: overlay.baseHarnessRelease,
        overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
      },
    }));
    if (!turn) throw new Error(`Prompt ${studyTask.id} local turn could not be updated.`);
    const foregroundUsage = usageSummary(attempt.metadata.usage);
    const attemptOutput = recordValue(attempt.output);
    const requiredOutputRows = Array.isArray(attemptOutput.requiredOutputs)
      ? attemptOutput.requiredOutputs
      : [];
    const attemptText = typeof attemptOutput.text === "string" ? attemptOutput.text : "";
    const outputsPassed = requiredOutputRows.length === 0
      ? attempt.infrastructureError === null && attemptText.trim().length > 0
      : attemptOutput.outputsPassed === true;
    const completionCheck = JSON.stringify({
      schemaVersion: "openpond.localObservationCompletionCheck.v1",
      passed: outputsPassed,
      score: outputsPassed ? 1 : 0,
      failureClass: attempt.infrastructureError ? attempt.metadata.failureClass : null,
      feedback: outputsPassed
        ? "The requested output was structurally materialized; this check does not assert subjective quality."
        : "The requested output was not structurally materialized.",
      evaluationCriteria: task.expectedOutput,
      attempt: {
        status: attempt.metadata.status,
        infrastructureError: attempt.infrastructureError,
        outputPresent: attemptText.trim().length > 0,
        artifactCount: attempt.artifactRefs.length,
        outputsPassed: attemptOutput.outputsPassed === true,
        toolFailureCount: numeric(attemptOutput.toolFailureCount),
        modelRequestCount: foregroundUsage.modelRequestCount,
        latencyMs: attempt.latencyMs,
        usage: foregroundUsage,
      },
    });
    await store.appendRuntimeEvent(event({
      sessionId,
      turnId,
      name: "diagnostic",
      source: "server",
      action: "taskset_grade",
      status: outputsPassed ? "completed" : "failed",
      output: completionCheck,
      error: outputsPassed ? undefined : completionCheck,
      data: { result: { output: completionCheck, passed: outputsPassed, score: outputsPassed ? 1 : 0 } },
    }));
    const detection = await recordLocalHarnessImprovementBoundary({
      store,
      session,
      turn,
      boundaryKind: "turn_completed",
    });
    let outcome: HarnessRefinerOutcome | null = null;
    const refinerUsage: unknown[] = [];
    if (detection?.trigger.decision === "queue_refiner") {
      const result = await runLocalHarnessRefinerWorker({
        store,
        storeDir: STORE_DIR,
        trigger: detection.trigger,
        signal: new AbortController().signal,
        stream: async function* ({ messages, signal }) {
          for await (const delta of streamOpenPondHostedChatTurn({
            model: MODEL.modelId,
            messages,
            requestId: `observation-refiner:${detection.trigger.id}`,
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
    const taskReceipt = {
      promptId: studyTask.id,
      expectedOutputKind: studyTask.expectedOutputKind,
      fixtureNames: studyTask.fixtures,
      sessionId,
      turnId,
      attempt,
      foregroundUsage: attempt.metadata.usage ?? [],
      trigger: detection?.trigger ?? null,
      outcome,
      refinerUsage,
      harnessChanged: outcome?.decision === "proposed",
    };
    (receipt.tasks as unknown[]).push(taskReceipt);
    await persistReceipt(receipt);
    const classification = classifyOutcome(outcome, detection?.trigger ?? null);
    process.stdout.write(
      `TASK_COMPLETE prompt-${String(studyTask.id).padStart(3, "0")} ${classification} `
      + `foreground_tokens=${usageTotal(attempt.metadata.usage)} `
      + `refiner_tokens=${usageTotal(refinerUsage)}\n`,
    );
  }
  receipt.completedAt = new Date().toISOString();
  receipt.finalHarness = releaseRef(await loadSelectedLocalHarnessRuntime(store));
  await persistReceipt(receipt);
  process.stdout.write(
    `BATCH_COMPLETE ${selectedTasks.length}/${selectedTasks.length} local receipt=${OUTPUT_PATH}\n`,
  );
} finally {
  await store.close();
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

async function localObservationTaskset(tasks: StudyTask[]): Promise<Taskset> {
  const sourceId = "source-harness-refiner-observation-local";
  const tasksetRoot = path.join(STORE_DIR!, "training", "tasksets", TASKSET_ID);
  const assetRoot = path.join(tasksetRoot, "assets");
  await mkdir(assetRoot, { recursive: true });
  const fileMetadata = new Map<string, { sha256: string; sizeBytes: number; mediaType: string }>();
  for (const fixtureName of [...new Set(tasks.flatMap((task) => task.fixtures))]) {
    const sourcePath = path.join(FIXTURE_ROOT, fixtureName);
    const bytes = await readFile(sourcePath);
    await copyFile(sourcePath, path.join(assetRoot, fixtureName));
    fileMetadata.set(fixtureName, {
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: fixtureName.endsWith(".csv") ? "text/csv" : "text/markdown",
    });
  }
  const taskRows: TaskDataRecord[] = tasks.map((task) => ({
    schemaVersion: "openpond.taskData.v1",
    id: taskId(task.id),
    clusterKey: `observation-${task.expectedOutputKind}`,
    split: "validation",
    input: { prompt: task.prompt },
    expectedOutput: { kind: task.expectedOutputKind },
    policyVisibleContext: {},
    privilegedContextRef: null,
    sourceRefs: [sourceId],
    assets: task.fixtures.map((fixtureName) => {
      const metadata = fileMetadata.get(fixtureName)!;
      return {
        id: `asset-${contentHash([task.id, fixtureName]).slice(0, 24)}`,
        sourceRefId: sourceId,
        artifactRef: `assets/${fixtureName}`,
        fileName: fixtureName,
        mediaType: metadata.mediaType,
        sha256: metadata.sha256,
        sizeBytes: metadata.sizeBytes,
        split: "validation" as const,
        metadata: {},
      };
    }),
    requiredOutputs: requiredOutputs(task),
    tags: [task.expectedOutputKind],
    metadata: { observationPromptId: task.id },
  }));
  const sourceFileHashes = [...fileMetadata.values()].map((metadata) => metadata.sha256);
  const hash = contentHash({ tasks: taskRows, tools: WORK_TOOL_NAMES, orderSeed: ORDER_SEED });
  return {
    id: TASKSET_ID,
    name: "Harness Refiner local observation batch 1",
    contentHash: hash,
    sourceRefs: [{
      id: sourceId,
      kind: "uploaded_file",
      sourceFileHashes,
      originalFileNames: [...fileMetadata.keys()],
      mediaTypes: [...new Set([...fileMetadata.values()].map((metadata) => metadata.mediaType))],
      secretScanStatus: "passed",
      piiScanStatus: "passed",
      licensingStatus: "approved",
    }],
    environment: {
      kind: "work",
      entrypoint: "openpond-local-work-v1",
      toolNames: WORK_TOOL_NAMES,
      defaultTimeoutMs: 20 * 60_000,
      metadata: { maxToolTurns: 40, execution: "desktop_local_work" },
    },
    tasks: taskRows,
  } as unknown as Taskset;
}

function requiredOutputs(task: StudyTask): TaskDataRecord["requiredOutputs"] {
  if (task.expectedOutputKind === "text") return [];
  const output = {
    pdf: { path: "welcome-packet.pdf", mediaType: "application/pdf" },
    html: { path: "operations-dashboard.html", mediaType: "text/html" },
    xlsx: {
      path: "staffing-schedule.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  }[task.expectedOutputKind];
  return output ? [{ ...output, maxBytes: 10_000_000, metadata: {} }] : [];
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

function releaseRef(runtime: Awaited<ReturnType<typeof loadSelectedLocalHarnessRuntime>>) {
  return runtime
    ? { id: runtime.release.harnessRelease.id, contentHash: runtime.release.harnessRelease.contentHash }
    : null;
}

function taskId(id: number): string {
  return `observation-prompt-${String(id).padStart(3, "0")}`;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function usageTotal(value: unknown): number {
  const usages = Array.isArray(value) ? value : value ? [value] : [];
  return usages.reduce((total, usage) => {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return total;
    const record = usage as Record<string, unknown>;
    const totalTokens = record.total_tokens ?? record.totalTokens;
    if (typeof totalTokens === "number") return total + totalTokens;
    const inputTokens = record.input_tokens ?? record.prompt_tokens ?? record.promptTokens ?? 0;
    const outputTokens = record.output_tokens ?? record.completion_tokens ?? record.completionTokens ?? 0;
    return total + (typeof inputTokens === "number" ? inputTokens : 0)
      + (typeof outputTokens === "number" ? outputTokens : 0);
  }, 0);
}

function usageSummary(value: unknown): {
  modelRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const usages = Array.isArray(value) ? value : value ? [value] : [];
  return usages.reduce(
    (total, usage) => {
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) return total;
      const record = usage as Record<string, unknown>;
      const prompt = numeric(record.prompt_tokens ?? record.promptTokens ?? record.input_tokens);
      const completion = numeric(
        record.completion_tokens ?? record.completionTokens ?? record.output_tokens,
      );
      const reportedTotal = numeric(record.total_tokens ?? record.totalTokens);
      return {
        modelRequestCount: total.modelRequestCount + 1,
        promptTokens: total.promptTokens + prompt,
        completionTokens: total.completionTokens + completion,
        totalTokens: total.totalTokens + (reportedTotal || prompt + completion),
      };
    },
    { modelRequestCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function persistReceipt(receipt: Record<string, unknown>): Promise<void> {
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

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
