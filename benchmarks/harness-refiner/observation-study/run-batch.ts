import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import type {
  ChatAttachment,
  HarnessRefinerOutcome,
  RefinementTriggerDecision,
  RuntimeEvent,
  Session,
  Turn,
} from "@openpond/contracts";
import { SqliteStore } from "../../../apps/server/src/store/store.js";
import {
  cleanupObserved,
  fileOutputRefsFromEvents,
  terminalTurnEvent,
  workRuntimeCostFromEvents,
} from "../../../scripts/rfp-work-proof-support.js";

const ROOT = path.resolve(import.meta.dirname);
const FIXTURE_ROOT = path.join(ROOT, "fixtures");
const SERVER_URL = process.env.OPENPOND_APP_SERVER_URL?.trim() || "http://127.0.0.1:17914";
const STORE_DIR = process.env.OPENPOND_APP_HOME?.trim();
const OUTPUT_PATH = path.resolve(
  process.env.OPENPOND_REFINER_OBSERVATION_OUTPUT?.trim()
    || path.join("output", "harness-refiner-observation-study", "2026-08-12", "batch-01.json"),
);
const TURN_TIMEOUT_MS = 20 * 60_000;
const REFINER_TIMEOUT_MS = 5 * 60_000;
const MODEL = { providerId: "openpond", modelId: "openpond-chat" } as const;
const ORDER_SEED = "refiner-observation-2026-08-12-v1";

if (!STORE_DIR) throw new Error("OPENPOND_APP_HOME is required for an isolated observation run.");

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

const initialHistory = await api<Record<string, unknown>>("/v1/harness", { method: "GET" });
const workspaceId = nestedString(initialHistory, ["workspace", "id"]);
if (!workspaceId) throw new Error("The isolated Personal Local Harness workspace is unavailable.");
await api("/v1/harness/background-review", {
  method: "POST",
  body: { workspaceId, enabled: true },
});

const receipt: Record<string, unknown> = {
  schemaVersion: "openpond.harnessRefinerObservationBatch.v1",
  study: "2026-08-11-harness-refiner-50-prompt-observation-study",
  batch: 1,
  orderSeed: ORDER_SEED,
  batchTaskIds: selectedTasks.map((task) => task.id),
  runtime: { model: MODEL, serverUrl: SERVER_URL },
  startedAt: new Date().toISOString(),
  initialHarness: releaseRef(initialHistory),
  tasks: [],
};
await persistReceipt(receipt);

for (const [batchIndex, task] of selectedTasks.entries()) {
  process.stdout.write(`TASK_START ${batchIndex + 1}/${selectedTasks.length} prompt-${String(task.id).padStart(3, "0")}\n`);
  const historyBefore = await api<Record<string, unknown>>("/v1/harness", { method: "GET" });
  const attachments = await fixtureAttachments(task.fixtures);
  const taskStartedAt = new Date().toISOString();
  const session = await api<Session>("/v1/sessions", {
    method: "POST",
    body: {
      experience: "work",
      provider: MODEL.providerId,
      modelRef: MODEL,
      openPondCommandAccessMode: "disabled",
      hiddenFromDefaultSidebar: true,
      title: `Refiner observation prompt ${task.id}`,
      cwd: null,
      metadata: {
        harnessRefinerObservationStudy: true,
        observationBatch: 1,
        observationPromptId: task.id,
        orderSeed: ORDER_SEED,
      },
    },
  });
  const turn = await api<Turn>(`/v1/sessions/${encodeURIComponent(session.id)}/turns`, {
    method: "POST",
    timeoutMs: TURN_TIMEOUT_MS + 60_000,
    body: {
      prompt: task.prompt,
      model: MODEL.modelId,
      modelRef: MODEL,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      attachments,
      metadata: {
        harnessRefinerObservationStudy: true,
        observationBatch: 1,
        observationPromptId: task.id,
        orderSeed: ORDER_SEED,
        userInterventions: 0,
      },
    },
  });
  let settled = await waitForTurn(session.id, turn.id, TURN_TIMEOUT_MS);
  process.stdout.write(
    `TURN_COMPLETE prompt-${String(task.id).padStart(3, "0")} ${settled.terminal.name}\n`,
  );

  let cleanupError: string | null = null;
  if (!cleanupObserved(settled.events)) {
    try {
      await api(`/v1/sessions/${encodeURIComponent(session.id)}/workspace-tools`, {
        method: "POST",
        body: { action: "sandbox_stop", args: {}, source: "chat_action" },
      });
    } catch (error) {
      cleanupError = errorMessage(error);
    }
  }

  const refinement = await waitForRefiner(session.id, turn.id, REFINER_TIMEOUT_MS);
  settled = await readTurn(session.id, turn.id);
  const historyAfter = await api<Record<string, unknown>>("/v1/harness", { method: "GET" });
  const store = new SqliteStore(STORE_DIR);
  try {
    const usage = await store.listModelUsageRecords({ turnId: turn.id, limit: 10_000 });
    const triggers = (await store.listHarnessImprovementArtifacts(
      workspaceId,
      "trigger_decision",
      1_000,
    ) as RefinementTriggerDecision[]).filter((candidate) => candidate.turnId === turn.id);
    const trigger = triggers.at(-1) ?? null;
    const outcomes = (await store.listHarnessImprovementArtifacts(
      workspaceId,
      "refiner_outcome",
      1_000,
    ) as HarnessRefinerOutcome[]).filter(
      (candidate) => trigger && candidate.trigger.contentHash === trigger.contentHash,
    );
    const outcome = outcomes.at(-1) ?? null;
    const outputRefs = fileOutputRefsFromEvents(settled.events);
    const taskReceipt = {
      promptId: task.id,
      batchIndex,
      expectedOutputKind: task.expectedOutputKind,
      prompt: task.prompt,
      promptSha256: sha256(task.prompt),
      fixtures: attachments.map((attachment) => ({
        name: attachment.name,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        sha256: sha256(Buffer.from(attachment.contentsBase64 ?? "", "base64")),
      })),
      startedAt: taskStartedAt,
      completedAt: settled.terminal.timestamp,
      sessionId: session.id,
      turnId: turn.id,
      terminalEvent: {
        name: settled.terminal.name,
        status: settled.terminal.status ?? null,
        error: settled.terminal.error ?? null,
      },
      harnessBefore: releaseRef(historyBefore),
      harnessAfter: releaseRef(historyAfter),
      harnessChanged:
        releaseRef(historyBefore)?.contentHash !== releaseRef(historyAfter)?.contentHash,
      outputs: outputRefs.map((output) => ({
        id: output.id,
        title: output.title,
        contentType: output.contentType,
        sizeBytes: output.sizeBytes,
        sha256: output.sha256,
        revision: output.revision,
        validation: output.validation,
      })),
      usage: usage.map((record) => ({
        requestId: record.requestId,
        requestKind: record.requestKind,
        visibility: record.visibility,
        status: record.status,
        provider: record.provider,
        model: record.model,
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        totalTokens: record.totalTokens,
        durationMs: record.durationMs,
        firstTokenMs: record.firstTokenMs,
      })),
      workRuntimeCost: workRuntimeCostFromEvents(settled.events),
      cleanupObserved: cleanupObserved(settled.events),
      cleanupError,
      refinerEvent: refinement
        ? {
            name: refinement.name,
            status: refinement.status ?? null,
            output: refinement.output ?? null,
            error: refinement.error ?? null,
            data: refinement.data ?? null,
          }
        : null,
      trigger: trigger
        ? {
            id: trigger.id,
            contentHash: trigger.contentHash,
            decision: trigger.decision,
            reason: trigger.reason,
            observationCount: trigger.observations.length,
          }
        : null,
      outcome: outcome
        ? {
            id: outcome.id,
            contentHash: outcome.contentHash,
            decision: outcome.decision,
            reason: outcome.reason,
            proposal: outcome.proposal,
            metadata: outcome.metadata,
          }
        : null,
    };
    (receipt.tasks as unknown[]).push(taskReceipt);
    await persistReceipt(receipt);
    const routedTo = outcome?.metadata?.routed === true
      && typeof outcome.metadata.route === "string"
      ? outcome.metadata.route
      : null;
    process.stdout.write(
      `REFINER_COMPLETE prompt-${String(task.id).padStart(3, "0")} `
      + `${routedTo ? `route_${routedTo}` : outcome?.decision ?? refinement?.name ?? "missing"} `
      + `changed=${taskReceipt.harnessChanged} `
      + `foreground_tokens=${foregroundTokens(usage)}\n`,
    );
    if (settled.terminal.name !== "turn.completed") {
      throw new Error(
        `Prompt ${task.id} stopped the batch because its Work turn ended as ${settled.terminal.name}.`,
      );
    }
    if (!refinement || refinement.name !== "harness.refiner.completed") {
      throw new Error(
        `Prompt ${task.id} stopped the batch because its Harness Refiner review did not complete.`,
      );
    }
  } finally {
    await store.close();
  }
}

receipt.completedAt = new Date().toISOString();
receipt.finalHarness = releaseRef(await api<Record<string, unknown>>("/v1/harness", { method: "GET" }));
await persistReceipt(receipt);
process.stdout.write(`BATCH_COMPLETE ${selectedTasks.length}/${selectedTasks.length} receipt=${OUTPUT_PATH}\n`);

async function fixtureAttachments(fileNames: string[]): Promise<ChatAttachment[]> {
  const values: ChatAttachment[] = [];
  for (const fileName of fileNames) {
    const bytes = await readFile(path.join(FIXTURE_ROOT, fileName));
    const mediaType = fileName.endsWith(".csv") ? "text/csv" : "text/markdown";
    values.push({
      id: `attachment_${randomUUID()}`,
      name: fileName,
      relativePath: fileName,
      mediaType,
      sizeBytes: bytes.byteLength,
      kind: "file",
      lineCount: bytes.toString("utf8").split(/\r?\n/).length,
      text: bytes.toString("utf8"),
      contentsBase64: bytes.toString("base64"),
    });
  }
  return values;
}

async function waitForTurn(sessionId: string, turnId: string, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await readTurn(sessionId, turnId);
    if (current.terminal) return current as { events: RuntimeEvent[]; terminal: RuntimeEvent };
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for Work turn ${turnId}.`);
}

async function readTurn(sessionId: string, turnId: string) {
  const store = new SqliteStore(STORE_DIR!);
  try {
    const events = await store.runtimeEventsForSession(sessionId, { limit: 10_000 });
    return { events, terminal: terminalTurnEvent(events, turnId) };
  } finally {
    await store.close();
  }
}

async function waitForRefiner(sessionId: string, turnId: string, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { events } = await readTurn(sessionId, turnId);
    const event = events.find(
      (candidate) => candidate.turnId === turnId
        && (candidate.name === "harness.refiner.completed" || candidate.name === "harness.refiner.failed"),
    );
    if (event) return event;
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for Harness Refiner on turn ${turnId}.`);
}

async function api<T = unknown>(pathname: string, input: {
  method: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const target = new URL(`${SERVER_URL}${pathname}`);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const body = input.body === undefined ? null : JSON.stringify(input.body);
  const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const clientRequest = request(target, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === null
          ? {}
          : {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }),
      },
    }, (clientResponse) => {
      const chunks: Buffer[] = [];
      clientResponse.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      clientResponse.on("end", () => {
        resolve({
          status: clientResponse.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    clientRequest.setTimeout(input.timeoutMs ?? 30_000, () => {
      clientRequest.destroy(new Error(`${pathname} timed out after ${input.timeoutMs ?? 30_000}ms.`));
    });
    clientRequest.on("error", reject);
    if (body !== null) clientRequest.write(body);
    clientRequest.end();
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${pathname} returned HTTP ${response.status}: ${response.text.slice(0, 4_000)}`);
  }
  return JSON.parse(response.text) as T;
}

function releaseRef(history: Record<string, unknown>): { id: string; contentHash: string } | null {
  const workspace = record(history.workspace);
  const currentChannel = record(workspace.currentChannel);
  const release = record(currentChannel.release);
  return typeof release.id === "string" && typeof release.contentHash === "string"
    ? { id: release.id, contentHash: release.contentHash }
    : null;
}

function nestedString(value: unknown, keys: string[]): string | null {
  let current: unknown = value;
  for (const key of keys) current = record(current)[key];
  return typeof current === "string" && current ? current : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function foregroundTokens(records: Awaited<ReturnType<SqliteStore["listModelUsageRecords"]>>) {
  return records
    .filter((record) => record.visibility === "user_facing")
    .reduce((total, record) => total + (record.totalTokens ?? 0), 0);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistReceipt(value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
