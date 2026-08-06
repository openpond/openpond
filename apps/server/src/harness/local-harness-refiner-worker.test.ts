import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createImprovementObservation,
  createRefinementTriggerDecision,
} from "@openpond/contracts";
import { contentHash } from "@openpond/evals";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";
import { DEFAULT_REFINEMENT_TRIGGER_POLICY } from "./improvement-trigger-detector.js";
import {
  createLocalHarnessWorkspace,
  localHarnessWorkspacePaths,
} from "./local-harness-workspace-service.js";
import { runLocalHarnessRefinerWorker } from "./local-harness-refiner-worker.js";
import { ensureLocalHarnessRunOverlay } from "./local-harness-run-overlay.js";

const NOW = "2026-08-05T20:00:00.000Z";
const LATER = "2026-08-05T20:01:00.000Z";

const cleanup: Array<{ directory: string; store: SqliteStore }> = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async ({ directory, store }) => {
      await store.close();
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

async function fixture(runId: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-refiner-"));
  const store = new SqliteStore(directory);
  cleanup.push({ directory, store });
  const created = await createLocalHarnessWorkspace({
    store,
    storeDir: directory,
    id: "personal-refiner",
    ownerId: "desktop-personal",
    name: "Personal Harness",
    now: () => NOW,
  });
  await store.selectHarnessWorkspace({
    ownerKind: "personal",
    ownerId: "desktop-personal",
    workspaceId: created.workspace.id,
    updatedAt: NOW,
  });
  const overlay = await ensureLocalHarnessRunOverlay({
    store,
    runId,
    workspace: created.workspace,
    harnessRelease: {
      id: created.release.harnessRelease.id,
      contentHash: created.release.harnessRelease.contentHash,
    },
    admittedAt: NOW,
  });
  const eventRef = {
    id: `event-${runId}`,
    sequence: 2,
    contentHash: contentHash({ runId, event: "recovered command failure" }),
  };
  const observation = createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: `observation-${runId}`,
    runRef: runId,
    turnId: `turn-${runId}`,
    harnessRelease: overlay.baseHarnessRelease,
    overlay: {
      id: overlay.id,
      revision: overlay.revision,
      contentHash: overlay.contentHash,
    },
    eventRefs: [eventRef],
    kind: "recovery",
    state: "recovered",
    tool: {
      name: "exec_command",
      invocationKey: contentHash({ runId, invocation: "first" }),
    },
    deterministicClass: "recovered_command_exit_nonzero",
    summary: "The first command failed and a corrected invocation succeeded.",
    createdAt: NOW,
    metadata: {},
  });
  await store.saveHarnessImprovementArtifact(
    created.workspace.id,
    "observation",
    observation,
  );
  const trigger = createRefinementTriggerDecision({
    schemaVersion: "openpond.refinementTriggerDecision.v1",
    id: `trigger-${runId}`,
    runRef: runId,
    turnId: `turn-${runId}`,
    harnessRelease: overlay.baseHarnessRelease,
    overlay: {
      id: overlay.id,
      revision: overlay.revision,
      contentHash: overlay.contentHash,
    },
    observations: [{ id: observation.id, contentHash: observation.contentHash }],
    decision: "queue_refiner",
    deterministicRoute: null,
    suggestedRoutes: ["runtime", "skill", "prompt"],
    reason: "A recovered command detour may be reusable.",
    deduplicationKey: contentHash({ runId, dedupe: true }),
    policy: DEFAULT_REFINEMENT_TRIGGER_POLICY,
    estimatedMaxCostUsd: 0.01,
    pendingPlanCount: 0,
    boundary: {
      kind: "turn_completed",
      eventSequence: 2,
      occurredAt: NOW,
    },
    cooldownUntil: null,
    createdAt: NOW,
    metadata: {},
  });
  await store.saveHarnessImprovementArtifact(
    created.workspace.id,
    "trigger_decision",
    trigger,
  );
  return { directory, store, ...created, overlay, trigger };
}

describe("local Harness Refiner worker", () => {
  it("atomically freezes a proposal, validates it, and advances Personal current", async () => {
    const current = await fixture("run-refine");
    const paths = localHarnessWorkspacePaths(current.directory, current.workspace.id);
    const target = path.join(paths.source, "instructions", "system.md");
    const before = await fs.readFile(target, "utf8");
    const replacement = `${before.trimEnd()}\n\nWhen a harmless command fails because of malformed syntax, correct only that command and continue from the current checkpoint.\n`;
    let calls = 0;

    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      stream: async function* () {
        calls += 1;
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v1",
            decision: "propose",
            route: "prompt",
            target: "instructions/system.md",
            summary: "Recover from a malformed command without restarting completed work.",
            replacementContent: replacement,
            expectedOutcome: "Equivalent tasks avoid restarting after one corrected command.",
            reason: "The trace contains a successful recovery that is safe to encode as a textual instruction.",
          }),
        };
      },
    });

    expect(calls).toBe(1);
    expect(result.outcome.decision).toBe("proposed");
    expect(result.validations.map((validation) => validation.status)).toEqual(["passed"]);
    expect(result.advanceReceipt?.decision).toBe("advanced");
    expect(result.overlay.status).toBe("frozen");
    expect(result.overlay.revision).toBe(1);
    expect(await fs.readFile(target, "utf8")).toBe(replacement);
    expect(result.workspace.currentChannel.release).not.toEqual(
      current.workspace.currentChannel.release,
    );

    const freshOverlay = await ensureLocalHarnessRunOverlay({
      store: current.store,
      runId: "fresh-run",
      workspace: result.workspace,
      harnessRelease: result.workspace.currentChannel.release!,
      admittedAt: LATER,
    });
    expect(freshOverlay.baseHarnessRelease).toEqual(
      result.workspace.currentChannel.release,
    );
    expect(freshOverlay.baseHarnessRelease).not.toEqual(
      current.overlay.baseHarnessRelease,
    );
  });

  it("persists a bounded no-action outcome without changing the overlay or Harness", async () => {
    const current = await fixture("run-no-action");
    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      stream: async function* () {
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v1",
            decision: "no_action",
            reason: "The failure was conversation-specific and does not justify a durable Harness change.",
          }),
        };
      },
    });

    expect(result.outcome.decision).toBe("no_action");
    expect(result.proposal).toBeNull();
    expect(result.advanceReceipt).toBeNull();
    expect(await current.store.getHarnessRunOverlay(current.trigger.runRef)).toEqual(
      current.overlay,
    );
    expect(
      (await current.store.getHarnessWorkspace(current.workspace.id))?.currentChannel,
    ).toEqual(current.workspace.currentChannel);
  });
});
