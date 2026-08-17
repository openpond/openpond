import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SessionSchema,
  TurnSchema,
  type RuntimeEvent,
} from "@openpond/contracts";
import type { LocalHarnessRefinerDecisionV2 } from "@openpond/harness";
import { afterEach, describe, expect, it } from "vitest";

import { createBackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import { SqliteStore } from "../store/store.js";
import { recordLocalHarnessImprovementBoundary } from "./local-harness-improvement-observer.js";
import { createLocalHarnessImprovementRuntime } from "./local-harness-improvement-runtime.js";
import { ensureLocalHarnessRunOverlay } from "./local-harness-run-overlay.js";
import { loadSelectedLocalHarnessRuntime } from "./local-harness-skill-runtime.js";
import { createLocalHarnessWorkspace } from "./local-harness-workspace-service.js";

const BEFORE = "2026-08-05T21:00:00.000Z";
const AFTER = "2026-08-05T21:05:00.000Z";
const SAFE_COMMAND_GUIDANCE =
  "For converter reports, use `openpond-report --safe` directly and do not retry the legacy converter.";

const cleanup: Array<{ directory: string; store: SqliteStore }> = [];

function refinerDelta(decision: LocalHarnessRefinerDecisionV2) {
  return { type: "text_delta" as const, text: JSON.stringify(decision), raw: null };
}

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
    let refinerModelCalls = 0;
    const processBoundary = createLocalHarnessImprovementRuntime({
      store,
      storeDir: directory,
      queue,
      appendRuntimeEvent: (runtimeEvent) => store.appendRuntimeEvent(runtimeEvent),
      upsertModelUsageRecord: async (record) => {
        await store.upsertModelUsageRecord(record);
      },
      streamOpenPondHostedChatTurn: async function* ({ messages }) {
        refinerModelCalls += 1;
        const evidence = messages.at(-1)?.content ?? "";
        if (evidence.includes(SAFE_COMMAND_GUIDANCE)) {
          yield refinerDelta({
              schemaVersion: "openpond.localHarnessRefinerDecision.v2",
              decision: "no_action",
              reason: "The completed turn succeeded with the existing safe converter guidance.",
          });
          return;
        }
        const anchor = initialInstructions.trimEnd().split("\n").at(-1)!;
        yield refinerDelta({
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "prompt",
            operation: "update",
            target: "instructions/system.md",
            summary: "Avoid the recovered legacy converter detour.",
            evidenceBasis: {
              kind: "single_deterministic",
              supportingEvidenceIds: [first.turn.id],
              counterevidence: [],
            },
            createContent: null,
            find: anchor,
            replace: `${anchor}\n\n${SAFE_COMMAND_GUIDANCE}`,
            expectedOutcome:
              "The next equivalent report task uses the safe converter without the failed legacy attempt.",
            reason:
              "The evidence contains a successful recovery with a smaller reusable command path.",
        });
      },
    });

    await processBoundary({
      session: first.session,
      turn: first.turn,
      boundaryKind: "turn_completed",
    });
    await queue.drain();
    expect(refinerModelCalls).toBe(2);

    expect(queue.receipts()).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    const refinerEvents = await store.runtimeEventsForSession(first.session.id);
    expect(refinerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "harness.refiner.completed",
          status: "completed",
          data: expect.objectContaining({
            workspaceAdvance: "advanced",
            activity: expect.objectContaining({
              schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1",
              visibility: "material_only",
              state: "completed",
              result: "applied",
              decision: "propose",
              route: "prompt",
              operation: "update",
              target: "instructions/system.md",
              evidenceBasis: {
                kind: "single_deterministic",
                supportingEvidenceIds: [first.turn.id],
                counterevidence: [],
              },
              critiqueStatus: "passed",
              validationStatus: "passed",
              inputHarness: expect.objectContaining({
                contentHash: initialRuntime.release.harnessRelease.contentHash,
              }),
              outputHarness: expect.objectContaining({
                contentHash: expect.any(String),
              }),
              edits: expect.arrayContaining([
                expect.objectContaining({
                  operation: "update",
                  target: "instructions/system.md",
                }),
              ]),
            }),
            timing: expect.objectContaining({
              queueWaitMs: expect.any(Number),
              modelDurationMs: expect.any(Number),
              materializationDurationMs: expect.any(Number),
              totalJobDurationMs: expect.any(Number),
            }),
          }),
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
    expect(refinerModelCalls).toBe(3);

    const secondEvents = await store.runtimeEventsForSession(second.session.id);
    expect(secondEvents.some((event) => event.status === "failed")).toBe(false);
    expect(queue.receipts()).toHaveLength(2);
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
      expect.objectContaining({ decision: "queue_refiner" }),
    ]);
    const secondOutcomes = (
      await store.listHarnessImprovementArtifacts(
        improvedRuntime.workspace.id,
        "refiner_outcome",
      )
    ).filter(
      (artifact) =>
        artifact.schemaVersion === "openpond.harnessRefinerOutcome.v1" &&
        artifact.trigger.id === secondTriggers[0]?.id,
    );
    expect(secondOutcomes).toEqual([
      expect.objectContaining({ decision: "no_action" }),
    ]);

    const recovered = await admitRun({
      store,
      runtime: improvedRuntime,
      runId: "refinement-acceptance-restart",
      admittedAt: AFTER,
    });
    await executeScriptedConverterTask({
      store,
      sessionId: recovered.session.id,
      turnId: recovered.turn.id,
      instructions: improvedInstructions,
      occurredAt: AFTER,
    });
    await recordLocalHarnessImprovementBoundary({
      store,
      session: recovered.session,
      turn: recovered.turn,
      boundaryKind: "turn_completed",
    });
    expect(await store.listPendingHarnessRefinerTriggers()).toHaveLength(1);

    await expect(processBoundary.reconcilePending()).resolves.toBe(1);
    await queue.drain();
    expect(await store.listPendingHarnessRefinerTriggers()).toHaveLength(0);
    const recoveredEvents = await store.runtimeEventsForSession(recovered.session.id);
    expect(recoveredEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "harness.refiner.queued",
        data: expect.objectContaining({ recoveredAfterRestart: true }),
      }),
      expect.objectContaining({
        name: "harness.refiner.completed",
        status: "completed",
        data: expect.objectContaining({ recoveredAfterRestart: true }),
      }),
    ]));
  });

  it("keeps a completed foreground turn intact and retries one failed hosted review without duplicate application", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openpond-harness-refinement-retry-"),
    );
    const store = new SqliteStore(directory);
    cleanup.push({ directory, store });
    const created = await createLocalHarnessWorkspace({
      store,
      storeDir: directory,
      id: "personal-refinement-retry",
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
    const runtime = await loadSelectedLocalHarnessRuntime(store);
    if (!runtime) throw new Error("Local Harness runtime was not selected.");
    const admitted = await admitRun({
      store,
      runtime,
      runId: "refinement-retry",
      admittedAt: BEFORE,
    });
    await executeScriptedConverterTask({
      store,
      sessionId: admitted.session.id,
      turnId: admitted.turn.id,
      instructions: await readRuntimeInstructions(runtime.release.bundlePath),
      occurredAt: BEFORE,
    });

    const queue = createBackgroundWorkerQueue({
      queueId: "local-harness-refinement-retry",
    });
    let attempts = 0;
    const processBoundary = createLocalHarnessImprovementRuntime({
      store,
      storeDir: directory,
      queue,
      appendRuntimeEvent: (runtimeEvent) => store.appendRuntimeEvent(runtimeEvent),
      upsertModelUsageRecord: async (record) => {
        await store.upsertModelUsageRecord(record);
      },
      streamOpenPondHostedChatTurn: async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Harness Refiner model request failed: 503 temporarily unavailable");
        }
        yield refinerDelta({
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "no_action",
          reason: "The recovered detour does not justify a durable Harness change.",
        });
      },
    });

    await expect(
      processBoundary({
        session: admitted.session,
        turn: admitted.turn,
        boundaryKind: "turn_completed",
      }),
    ).resolves.toBeUndefined();
    expect((await store.getTurn(admitted.turn.id))?.status).toBe("completed");
    await queue.drain();

    expect(queue.receipts().map((receipt) => receipt.status)).toEqual(["failed"]);
    expect(await store.listPendingHarnessRefinerTriggers()).toHaveLength(1);
    expect(await store.runtimeEventsForSession(admitted.session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "harness.refiner.failed",
          status: "failed",
        }),
      ]),
    );

    await expect(processBoundary.reconcilePending()).resolves.toBe(1);
    await queue.drain();

    expect(attempts).toBe(2);
    expect(queue.receipts().map((receipt) => receipt.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(await store.listPendingHarnessRefinerTriggers()).toHaveLength(0);
    const outcomes = await store.listHarnessImprovementArtifacts(
      runtime.workspace.id,
      "refiner_outcome",
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ decision: "no_action" });
    expect(await store.runtimeEventsForSession(admitted.session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "harness.refiner.completed",
          status: "completed",
          data: expect.objectContaining({ recoveredAfterRestart: true }),
        }),
      ]),
    );

    await expect(processBoundary.reconcilePending()).resolves.toBe(0);
    expect(attempts).toBe(2);
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
  await input.store.appendRuntimeEvent({
    id: `event-turn-started-${turn.id}`,
    sessionId: session.id,
    turnId: turn.id,
    name: "turn.started",
    timestamp: input.admittedAt,
    source: "chat_action",
    status: "started",
    args: { prompt: turn.prompt },
  });
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
