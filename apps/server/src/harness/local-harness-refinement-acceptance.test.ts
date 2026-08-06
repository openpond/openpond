import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SessionSchema,
  TurnSchema,
  type RuntimeEvent,
} from "@openpond/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createBackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import { SqliteStore } from "../store/store.js";
import { createLocalHarnessImprovementRuntime } from "./local-harness-improvement-runtime.js";
import { ensureLocalHarnessRunOverlay } from "./local-harness-run-overlay.js";
import { loadSelectedLocalHarnessRuntime } from "./local-harness-skill-runtime.js";
import { createLocalHarnessWorkspace } from "./local-harness-workspace-service.js";

const BEFORE = "2026-08-05T21:00:00.000Z";
const AFTER = "2026-08-05T21:05:00.000Z";
const SAFE_COMMAND_GUIDANCE =
  "For converter reports, use `openpond-report --safe` directly and do not retry the legacy converter.";

const cleanup: Array<{ directory: string; store: SqliteStore }> = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async ({ directory, store }) => {
      await store.close();
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Local Harness refinement acceptance", () => {
  it("turns a recovered converter failure into a release that avoids the same failure", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openpond-harness-refinement-acceptance-"),
    );
    const store = new SqliteStore(directory);
    cleanup.push({ directory, store });
    const created = await createLocalHarnessWorkspace({
      store,
      storeDir: directory,
      id: "personal-refinement-acceptance",
      ownerId: "desktop-personal",
      name: "Personal Harness",
      now: () => BEFORE,
    });
    await store.selectHarnessWorkspace({
      ownerKind: "personal",
      ownerId: "desktop-personal",
      workspaceId: created.workspace.id,
      updatedAt: BEFORE,
    });

    const initialRuntime = await loadSelectedLocalHarnessRuntime(store);
    if (!initialRuntime) throw new Error("Initial Local Harness runtime was not selected.");
    const initialInstructions = await readRuntimeInstructions(initialRuntime.release.bundlePath);
    expect(initialInstructions).not.toContain(SAFE_COMMAND_GUIDANCE);

    const first = await admitRun({
      store,
      runtime: initialRuntime,
      runId: "refinement-acceptance-before",
      admittedAt: BEFORE,
    });
    const firstCommands = await executeScriptedConverterTask({
      store,
      sessionId: first.session.id,
      turnId: first.turn.id,
      instructions: initialInstructions,
      occurredAt: BEFORE,
    });
    expect(firstCommands).toEqual([
      "openpond-report --legacy",
      "openpond-report --safe",
    ]);

    const queue = createBackgroundWorkerQueue({
      queueId: "local-harness-refinement-acceptance",
    });
    const processBoundary = createLocalHarnessImprovementRuntime({
      store,
      storeDir: directory,
      queue,
      appendRuntimeEvent: (runtimeEvent) => store.appendRuntimeEvent(runtimeEvent),
      upsertModelUsageRecord: async (record) => {
        await store.upsertModelUsageRecord(record);
      },
      streamOpenPondHostedChatTurn: async function* () {
        const replacement = `${initialInstructions.trimEnd()}\n\n${SAFE_COMMAND_GUIDANCE}\n`;
        yield {
          type: "text_delta" as const,
          text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v1",
            decision: "propose",
            route: "prompt",
            operation: "update",
            target: "instructions/system.md",
            summary: "Avoid the recovered legacy converter detour.",
            replacementContent: replacement,
            expectedOutcome:
              "The next equivalent report task uses the safe converter without the failed legacy attempt.",
            reason:
              "The evidence contains a successful recovery with a smaller reusable command path.",
          }),
          raw: { fixture: "refinement-acceptance" },
        };
      },
    });

    await processBoundary({
      session: first.session,
      turn: first.turn,
      boundaryKind: "turn_completed",
    });
    await queue.drain();

    expect(queue.receipts()).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    const refinerEvents = await store.runtimeEventsForSession(first.session.id);
    expect(refinerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "harness.refiner.completed",
          status: "completed",
          data: expect.objectContaining({ workspaceAdvance: "advanced" }),
        }),
      ]),
    );

    const improvedRuntime = await loadSelectedLocalHarnessRuntime(store);
    if (!improvedRuntime) throw new Error("Improved Local Harness runtime was not selected.");
    expect(improvedRuntime.release.harnessRelease.contentHash).not.toBe(
      initialRuntime.release.harnessRelease.contentHash,
    );
    const improvedInstructions = await readRuntimeInstructions(
      improvedRuntime.release.bundlePath,
    );
    expect(improvedInstructions).toContain(SAFE_COMMAND_GUIDANCE);

    const second = await admitRun({
      store,
      runtime: improvedRuntime,
      runId: "refinement-acceptance-after",
      admittedAt: AFTER,
    });
    const secondCommands = await executeScriptedConverterTask({
      store,
      sessionId: second.session.id,
      turnId: second.turn.id,
      instructions: improvedInstructions,
      occurredAt: AFTER,
    });
    expect(secondCommands).toEqual(["openpond-report --safe"]);

    await processBoundary({
      session: second.session,
      turn: second.turn,
      boundaryKind: "turn_completed",
    });
    await queue.drain();

    const secondEvents = await store.runtimeEventsForSession(second.session.id);
    expect(secondEvents.some((event) => event.status === "failed")).toBe(false);
    expect(queue.receipts()).toHaveLength(1);
    const secondTriggers = (
      await store.listHarnessImprovementArtifacts(
        improvedRuntime.workspace.id,
        "trigger_decision",
      )
    ).filter(
      (artifact) =>
        artifact.schemaVersion === "openpond.refinementTriggerDecision.v1" &&
        artifact.runRef === second.session.id,
    );
    expect(secondTriggers).toEqual([
      expect.objectContaining({ decision: "no_action", estimatedMaxCostUsd: 0 }),
    ]);
  });
});

async function admitRun(input: {
  store: SqliteStore;
  runtime: NonNullable<Awaited<ReturnType<typeof loadSelectedLocalHarnessRuntime>>>;
  runId: string;
  admittedAt: string;
}) {
  const overlay = await ensureLocalHarnessRunOverlay({
    store: input.store,
    runId: input.runId,
    workspace: input.runtime.workspace,
    harnessRelease: {
      id: input.runtime.release.harnessRelease.id,
      contentHash: input.runtime.release.harnessRelease.contentHash,
    },
    admittedAt: input.admittedAt,
  });
  const session = SessionSchema.parse({
    id: input.runId,
    experience: "development",
    provider: "openpond",
    title: "Harness refinement acceptance",
    appId: null,
    appName: null,
    cwd: null,
    codexThreadId: null,
    createdAt: input.admittedAt,
    updatedAt: input.admittedAt,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  });
  const turn = TurnSchema.parse({
    id: `turn-${input.runId}`,
    sessionId: session.id,
    providerTurnId: null,
    prompt: "Create the converter report.",
    startedAt: input.admittedAt,
    completedAt: input.admittedAt,
    status: "completed",
    error: null,
    harnessSnapshot: {
      schemaVersion: "openpond.harnessTurnSnapshot.v1",
      workspaceId: input.runtime.workspace.id,
      workspaceRevision: input.runtime.workspace.revision,
      sourceRevision: input.runtime.workspace.sourceRevision,
      channelName: input.runtime.workspace.currentChannel.name,
      channelRevision: input.runtime.workspace.currentChannel.revision,
      harnessRelease: overlay.baseHarnessRelease,
      overlay: {
        id: overlay.id,
        revision: overlay.revision,
        contentHash: overlay.contentHash,
      },
    },
  });
  await input.store.insertSessionAtFront(session);
  await input.store.insertTurn(turn);
  return { session, turn };
}

async function executeScriptedConverterTask(input: {
  store: SqliteStore;
  sessionId: string;
  turnId: string;
  instructions: string;
  occurredAt: string;
}): Promise<string[]> {
  const commands = input.instructions.includes(SAFE_COMMAND_GUIDANCE)
    ? ["openpond-report --safe"]
    : ["openpond-report --legacy", "openpond-report --safe"];
  for (const [index, command] of commands.entries()) {
    const callId = `${input.turnId}-call-${index}`;
    await input.store.appendRuntimeEvent(
      runtimeToolEvent({
        id: `${callId}-started`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        callId,
        command,
        status: "started",
        occurredAt: input.occurredAt,
      }),
    );
    const result = await executeConverterCommand(command);
    await input.store.appendRuntimeEvent(
      runtimeToolEvent({
        id: `${callId}-completed`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        callId,
        command,
        status: result.exitCode === 0 ? "completed" : "failed",
        occurredAt: input.occurredAt,
        result,
      }),
    );
  }
  return commands;
}

function runtimeToolEvent(input: {
  id: string;
  sessionId: string;
  turnId: string;
  callId: string;
  command: string;
  status: "started" | "completed" | "failed";
  occurredAt: string;
  result?: { exitCode: number; stdout: string; stderr: string };
}): RuntimeEvent {
  const failed = input.status === "failed";
  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    name: input.status === "started" ? "tool.started" : "tool.completed",
    timestamp: input.occurredAt,
    source: "provider",
    action: "exec_command",
    status: input.status,
    output: input.result
      ? failed
        ? `${input.result.stderr.trim()} Command exited with code ${input.result.exitCode}.`
        : input.result.stdout.trim()
      : undefined,
    error: failed ? input.result?.stderr.trim() : undefined,
    args: { command: input.command },
    data: {
      toolCallId: input.callId,
      ...(input.result
        ? {
            result: {
              exitCode: input.result.exitCode,
              timedOut: false,
              stderr: input.result.stderr,
              stdout: input.result.stdout,
            },
          }
        : {}),
    },
  };
}

function executeConverterCommand(
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const source = command.endsWith("--legacy")
    ? "process.stderr.write('Unexpected converter response.'); process.exit(1);"
    : "process.stdout.write('REPORT_OK');";
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", source], (error, stdout, stderr) => {
      resolve({
        exitCode:
          error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function readRuntimeInstructions(bundlePath: string): Promise<string> {
  return fs.readFile(
    path.join(bundlePath, "source", "instructions", "system.md"),
    "utf8",
  );
}
