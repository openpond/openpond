import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessRefinerOutcome,
  RefinementTriggerDecision,
  RuntimeEvent,
} from "@openpond/contracts";
import { SqliteStore } from "../../../apps/server/src/store/store.js";
import {
  fileOutputRefsFromEvents,
  terminalTurnEvent,
  workRuntimeCostFromEvents,
} from "../../../scripts/rfp-work-proof-support.js";

const STORE_DIR = process.env.OPENPOND_APP_HOME?.trim();
if (!STORE_DIR) throw new Error("OPENPOND_APP_HOME is required.");
const OUTPUT_PATH = path.resolve(
  process.env.OPENPOND_REFINER_OBSERVATION_AUDIT_OUTPUT?.trim()
    || path.join("output", "harness-refiner-observation-study", "2026-08-12", "batch-01-audit.json"),
);
const FIXTURE_ROOT = path.resolve(import.meta.dirname, "fixtures");
const EXPECTED = new Map<number, {
  outputKind: "pdf" | "xlsx" | "html" | "text";
  fixtureNames: string[];
}>([
  [3, { outputKind: "pdf", fixtureNames: ["prompt-003-food-pantry-operational-notes.md"] }],
  [49, { outputKind: "text", fixtureNames: [] }],
  [45, { outputKind: "text", fixtureNames: ["prompt-045-customer-feedback.csv"] }],
  [22, { outputKind: "html", fixtureNames: ["prompt-022-fulfillment-data.csv"] }],
  [11, {
    outputKind: "xlsx",
    fixtureNames: [
      "prompt-011-event-requirements.csv",
      "prompt-011-employee-availability.csv",
    ],
  }],
]);

const store = new SqliteStore(STORE_DIR);
try {
  const sessions = (await store.sessionShells())
    .filter((session) => session.metadata?.harnessRefinerObservationStudy === true);
  const workspaceIds = new Set<string>();
  const rows = [];
  for (const session of sessions) {
    const promptId = numberValue(session.metadata?.observationPromptId);
    if (!promptId || !EXPECTED.has(promptId)) continue;
    const turns = await store.turnsForSession(session.id);
    const turn = turns.at(-1);
    if (!turn) continue;
    const expected = EXPECTED.get(promptId)!;
    const events = await store.runtimeEventsForSession(session.id, { limit: 10_000 });
    const terminal = terminalTurnEvent(events, turn.id);
    const workspaceId = turn.harnessSnapshot?.workspaceId ?? null;
    if (workspaceId) workspaceIds.add(workspaceId);
    const triggers = workspaceId
      ? (await store.listHarnessImprovementArtifacts(
          workspaceId,
          "trigger_decision",
          1_000,
        ) as RefinementTriggerDecision[]).filter((candidate) => candidate.turnId === turn.id)
      : [];
    const trigger = triggers.at(-1) ?? null;
    const outcomes = workspaceId && trigger
      ? (await store.listHarnessImprovementArtifacts(
          workspaceId,
          "refiner_outcome",
          1_000,
        ) as HarnessRefinerOutcome[]).filter(
          (candidate) => candidate.trigger.contentHash === trigger.contentHash,
        )
      : [];
    const outcome = outcomes.at(-1) ?? null;
    const usage = await store.listModelUsageRecords({ turnId: turn.id, limit: 10_000 });
    const answer = assistantText(events);
    const outputRefs = fileOutputRefsFromEvents(events);
    let requestedArtifactMaterialized: boolean | null = null;
    if (expected.outputKind !== "text") {
      requestedArtifactMaterialized = outputRefs.some((output) =>
        outputMatches(output.title, output.contentType, expected.outputKind as "pdf" | "xlsx" | "html")
      );
    }
    rows.push({
      promptId,
      sessionId: session.id,
      turnId: turn.id,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      terminal: terminal
        ? { name: terminal.name, status: terminal.status ?? null, error: terminal.error ?? null }
        : null,
      userInterventions: terminal?.name === "turn.interrupted" ? 1 : 0,
      harness: {
        admittedRelease: turn.harnessSnapshot?.harnessRelease ?? null,
        workspaceId,
      },
      expectedOutputKind: expected.outputKind,
      fixtures: await Promise.all(expected.fixtureNames.map(async (name) => {
        const bytes = await readFile(path.join(FIXTURE_ROOT, name));
        return { name, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
      })),
      completionEvidence: {
        answerPresent: answer.trim().length > 0,
        answerCharacters: answer.length,
        answerSha256: answer ? sha256(answer) : null,
        requestedArtifactMaterialized,
        outputCount: outputRefs.length,
      },
      outputs: outputRefs.map((output) => ({
        id: output.id,
        title: output.title,
        contentType: output.contentType,
        sizeBytes: output.sizeBytes,
        sha256: output.sha256,
        revision: output.revision,
        validation: output.validation,
      })),
      toolFailures: failedToolEvents(events),
      workRuntimeCost: workRuntimeCostFromEvents(events),
      usage: {
        foreground: usageSummary(usage.filter((record) => record.visibility === "user_facing")),
        background: usageSummary(usage.filter((record) => record.visibility === "background")),
        requests: usage.map((record) => ({
          requestId: record.requestId,
          requestKind: record.requestKind,
          visibility: record.visibility,
          status: record.status,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
          totalTokens: record.totalTokens,
          durationMs: record.durationMs,
          errorType: record.errorType,
          errorMessage: record.errorMessage,
        })),
      },
      trigger: trigger
        ? {
            id: trigger.id,
            contentHash: trigger.contentHash,
            decision: trigger.decision,
            reason: trigger.reason,
            observationCount: trigger.observations.length,
          }
        : null,
      refiner: outcome
        ? {
            outcomeId: outcome.id,
            outcomeHash: outcome.contentHash,
            decision: outcome.decision,
            classification: classifyOutcome(outcome),
            reason: outcome.reason,
            routed: outcome.metadata.routed === true,
            route: typeof outcome.metadata.route === "string" ? outcome.metadata.route : null,
            expectedOutcome:
              typeof outcome.metadata.expectedOutcome === "string"
                ? outcome.metadata.expectedOutcome
                : null,
            proposal: outcome.proposal,
          }
        : null,
    });
  }
  rows.sort(
    (left, right) =>
      [3, 49, 45, 22, 11].indexOf(left.promptId)
      - [3, 49, 45, 22, 11].indexOf(right.promptId),
  );
  const audit = {
    schemaVersion: "openpond.harnessRefinerObservationAudit.v1",
    study: "2026-08-11-harness-refiner-50-prompt-observation-study",
    batch: 1,
    orderSeed: "refiner-observation-2026-08-12-v1",
    batchTaskIds: [3, 49, 45, 22, 11],
    generatedAt: new Date().toISOString(),
    workspaceIds: [...workspaceIds],
    tasks: rows,
    summary: {
      attempted: rows.length,
      terminalCompleted: rows.filter((row) => row.terminal?.name === "turn.completed").length,
      interrupted: rows.filter((row) => row.terminal?.name === "turn.interrupted").length,
      reviewedByRefiner: rows.filter((row) => row.refiner !== null).length,
      runtimeRoutes: rows.filter((row) => row.refiner?.classification === "route_runtime").length,
      genuineNoAction: rows.filter((row) => row.refiner?.classification === "no_action").length,
      harnessChanges: rows.filter((row) => row.refiner?.classification === "proposal_applied").length,
      missingRequestedArtifacts: rows.filter(
        (row) => row.completionEvidence.requestedArtifactMaterialized === false,
      ).length,
      foregroundTokens: rows.reduce((total, row) => total + row.usage.foreground.totalTokens, 0),
      backgroundTokens: rows.reduce((total, row) => total + row.usage.background.totalTokens, 0),
    },
  };
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(audit.summary)}\n${OUTPUT_PATH}\n`);
} finally {
  await store.close();
}

function assistantText(events: RuntimeEvent[]): string {
  return events
    .filter((event) => event.name === "assistant.delta" && typeof event.output === "string")
    .map((event) => event.output ?? "")
    .join("");
}

function failedToolEvents(events: RuntimeEvent[]) {
  return events.flatMap((event) => {
    if (
      event.status !== "failed"
      || (event.name !== "tool.completed" && event.name !== "workspace_action_result")
    ) return [];
    return [{
      eventId: event.id,
      name: event.name,
      action: event.action ?? null,
      error: event.error ?? event.output ?? null,
    }];
  });
}

function outputMatches(title: string, contentType: string, kind: "pdf" | "xlsx" | "html"): boolean {
  const normalizedTitle = title.toLowerCase();
  const normalizedType = contentType.toLowerCase();
  if (kind === "pdf") return normalizedTitle.endsWith(".pdf") || normalizedType === "application/pdf";
  if (kind === "xlsx") {
    return normalizedTitle.endsWith(".xlsx")
      || normalizedType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return normalizedTitle.endsWith(".html") || normalizedType === "text/html";
}

function classifyOutcome(outcome: HarnessRefinerOutcome) {
  if (outcome.metadata.routed === true) {
    return `route_${typeof outcome.metadata.route === "string" ? outcome.metadata.route : "unknown"}`;
  }
  if (outcome.proposal) return "proposal_applied";
  return outcome.decision;
}

function usageSummary(records: Awaited<ReturnType<SqliteStore["listModelUsageRecords"]>>) {
  return records.reduce(
    (total, record) => ({
      requests: total.requests + 1,
      promptTokens: total.promptTokens + (record.promptTokens ?? 0),
      completionTokens: total.completionTokens + (record.completionTokens ?? 0),
      totalTokens: total.totalTokens + (record.totalTokens ?? 0),
    }),
    { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
