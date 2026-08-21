import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createImprovementObservation,
  createRefinementTriggerDecision,
  TurnSchema,
  type HarnessWorkspace,
} from "@openpond/contracts";
import {
  contentHash,
  type HarnessRefinerEvidenceBasis,
  type HostedHarnessRefinerRequest,
  type HostedHarnessRefinerResponse,
  type ImmutableReleaseRef,
  type LocalHarnessRefinerDecisionV2,
} from "@openpond/harness";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";
import { DEFAULT_REFINEMENT_TRIGGER_POLICY } from "./improvement-trigger-detector.js";
import {
  createLocalHarnessWorkspace,
  localHarnessWorkspacePaths,
} from "./local-harness-workspace-service.js";
import { runLocalHarnessRefinerWorker } from "./local-harness-refiner-worker.js";
import { reviewLocalHarnessProposalFromSettings } from "./local-harness-history.js";
import { rollbackLocalHarnessWorkspaceRelease } from "./local-harness-refiner.js";
import { ensureLocalHarnessRunOverlay } from "./local-harness-run-overlay.js";

const NOW = "2026-08-05T20:00:00.000Z";
const LATER = "2026-08-05T20:01:00.000Z";

const cleanup: Array<{ directory: string; store: SqliteStore }> = [];

function hostedResult(
  request: HostedHarnessRefinerRequest,
  decision: LocalHarnessRefinerDecisionV2,
): HostedHarnessRefinerResponse {
  return {
    schemaVersion: "openpond.hostedHarnessRefinerResponse.v2",
    requestId: request.requestId,
    evidenceHash: request.evidenceHash,
    admittedRelease: request.harness.admittedRelease,
    currentRelease: request.harness.currentRelease,
    decision,
    serviceRevision: "worker-test",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
}

function singleEvidence(
  request: HostedHarnessRefinerRequest,
): HarnessRefinerEvidenceBasis {
  const observation = request.evidence.observations[0];
  const id = typeof observation?.id === "string"
    ? observation.id
    : request.evidence.reviewPacket.currentTurn.id;
  return {
    kind: "single_deterministic",
    supportingEvidenceIds: [id],
    counterevidence: [],
  };
}

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
  const run = await addRunFixture({
    store,
    workspace: created.workspace,
    harnessRelease: created.release.harnessRelease,
    runId,
  });
  return { directory, store, ...created, ...run };
}

async function addRunFixture(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  harnessRelease: ImmutableReleaseRef;
  runId: string;
}) {
  const { store, workspace, harnessRelease, runId } = input;
  const overlay = await ensureLocalHarnessRunOverlay({
    store,
    runId,
    workspace,
    harnessRelease: {
      id: harnessRelease.id,
      contentHash: harnessRelease.contentHash,
    },
    admittedAt: NOW,
  });
  await store.insertTurn(TurnSchema.parse({
    id: `turn-${runId}`,
    sessionId: runId,
    providerTurnId: null,
    prompt: "Recover one malformed command without restarting the completed work. password=fixture-secret",
    startedAt: NOW,
    completedAt: NOW,
    status: "completed",
    error: null,
  }));
  await store.appendRuntimeEvent({
    id: `event-${runId}`,
    sessionId: runId,
    turnId: `turn-${runId}`,
    name: "tool.completed",
    timestamp: NOW,
    source: "provider",
    action: "exec_command",
    status: "failed",
    output: "Command exited with code 1.",
    data: {
      result: {
        exitCode: 1,
        timedOut: false,
        stderr: "Error: malformed syntax; access_token=fixture-token",
      },
    },
  });
  const runtimeEvent = (await store.runtimeEventsForSession(runId)).find(
    (candidate) => candidate.id === `event-${runId}`,
  );
  if (!runtimeEvent) throw new Error("Refiner fixture runtime event was not stored.");
  const eventRef = {
    id: runtimeEvent.id,
    sequence: runtimeEvent.sequence ?? null,
    contentHash: contentHash(runtimeEvent),
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
    workspace.id,
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
    workspace.id,
    "trigger_decision",
    trigger,
  );
  return { overlay, trigger };
}

describe("local Harness Refiner worker", () => {
  it("atomically freezes a proposal, validates it, and advances Personal current", async () => {
    const current = await fixture("run-refine");
    const paths = localHarnessWorkspacePaths(current.directory, current.workspace.id);
    const target = path.join(paths.source, "instructions", "system.md");
    const before = await fs.readFile(target, "utf8");
    const anchor = before.trimEnd().split("\n").at(-1)!;
    const replacement = before.replace(
      anchor,
      `${anchor}\n\nWhen a harmless command fails because of malformed syntax, correct only that command and continue from the current checkpoint.`,
    );
    let calls = 0;

    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      additionalEvidence: {
        schemaVersion: "openpond.harnessRefinerBenchmarkCohortEvidence.v1",
        adaptationEvidenceHash: "a".repeat(64),
      },
      signal: new AbortController().signal,
      now: () => LATER,
      refine: async ({ request }) => {
        calls += 1;
        const serializedEvidence = JSON.stringify(request.evidence);
        expect(serializedEvidence).toContain("password=[redacted]");
        expect(serializedEvidence).toContain("access_token=[redacted]");
        expect(serializedEvidence).not.toContain("fixture-secret");
        expect(serializedEvidence).not.toContain("fixture-token");
        expect(request.evidence.additionalEvidence).toEqual({
          schemaVersion: "openpond.harnessRefinerBenchmarkCohortEvidence.v1",
          adaptationEvidenceHash: "a".repeat(64),
        });
        expect(request.evidence.reviewPacket.executionProfile).toMatchObject({
          modelRequestCount: 0,
          totalTokens: 0,
          toolFailureCount: 0,
        });
        expect(request.evidence.capabilities).toEqual(request.harness.capabilities);
        expect(request.evidence.capabilities.agent).toBe(false);
        expect(request.evidence.reviewPacket.timeline).toEqual([
          expect.objectContaining({
            name: "tool.completed",
            action: "exec_command",
            status: "failed",
          }),
        ]);
        expect(request.evidence.reviewPacket.priorIncidents).toEqual([]);
        return hostedResult(request, {
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "prompt",
            operation: "update",
            target: "instructions/system.md",
            summary: "Recover from a malformed command without restarting completed work.",
            evidenceBasis: singleEvidence(request),
            createContent: null,
            find: anchor,
            replace: `${anchor}\n\nWhen a harmless command fails because of malformed syntax, correct only that command and continue from the current checkpoint.`,
            expectedOutcome: "Equivalent tasks avoid restarting after one corrected command.",
            reason: "The trace contains a successful recovery that is safe to encode as a textual instruction.",
        });
      },
    });

    expect(calls).toBe(1);
    expect(result.outcome.decision).toBe("proposed");
    expect(result.validations.map((validation) => validation.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(result.validations.at(-1)).toMatchObject({
      kind: "component_activation",
      status: "passed",
      metadata: {
        targetRuntime: "desktop_work",
        beforeEffectiveRuntimeHash: expect.any(String),
        afterEffectiveRuntimeHash: expect.any(String),
      },
    });
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

    const rolledBack = await rollbackLocalHarnessWorkspaceRelease({
      store: current.store,
      storeDir: current.directory,
      workspaceId: current.workspace.id,
      targetRelease: current.overlay.baseHarnessRelease,
      rollbackOf: result.workspace.currentChannel.release!,
      receiptId: "rollback-refiner-fixture",
      now: () => "2026-08-05T20:02:00.000Z",
    });
    expect(rolledBack.receipt.decision).toBe("rolled_back");
    expect(rolledBack.workspace.currentChannel.release).toEqual(
      current.overlay.baseHarnessRelease,
    );
    expect(await fs.readFile(target, "utf8")).toBe(before);
  });

  it("rebases a stale admitted run onto the atomically verified current release", async () => {
    const current = await fixture("run-rebase-first");
    const stale = await addRunFixture({
      store: current.store,
      workspace: current.workspace,
      harnessRelease: current.release.harnessRelease,
      runId: "run-rebase-stale",
    });

    const first = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      refine: async ({ request }) => {
        expect(request.evidence.runtimeActivation).toMatchObject({
          admittedRelease: current.overlay.baseHarnessRelease,
          currentRelease: current.overlay.baseHarnessRelease,
          rebasedOntoCurrent: false,
        });
        const source = request.evidence.sourceFiles.find(
          (candidate) => candidate.path === "instructions/system.md",
        );
        expect(source?.loaded).toBe(true);
        const anchor = source?.content.trimEnd().split("\n").at(-1);
        if (!anchor) throw new Error("Expected instruction source evidence.");
        return hostedResult(request, {
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "propose",
          route: "prompt",
          operation: "update",
          target: "instructions/system.md",
          summary: "Encode the first reusable recovery.",
          evidenceBasis: singleEvidence(request),
          createContent: null,
          find: anchor,
          replace: `${anchor}\n\nCorrect one harmless malformed command and continue.`,
          expectedOutcome: "Equivalent tasks recover without restarting.",
          reason: "The recovered detour is reusable.",
        });
      },
    });
    expect(first.advanceReceipt?.decision).toBe("advanced");

    const rebased = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: stale.trigger,
      signal: new AbortController().signal,
      now: () => "2026-08-05T20:02:00.000Z",
      refine: async ({ request }) => {
        expect(request.harness.admittedRelease).toEqual(
          stale.overlay.baseHarnessRelease,
        );
        expect(request.harness.currentRelease).toEqual(
          first.workspace.currentChannel.release,
        );
        expect(request.evidence.runtimeActivation).toMatchObject({
          admittedRelease: stale.overlay.baseHarnessRelease,
          currentRelease: first.workspace.currentChannel.release,
          rebasedOntoCurrent: true,
        });
        expect(request.evidence.reviewPacket.priorIncidents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runRef: current.trigger.runRef,
              turnId: current.trigger.turnId,
              timeline: expect.arrayContaining([
                expect.objectContaining({
                  name: "tool.completed",
                  status: "failed",
                  occurrenceCount: 1,
                }),
              ]),
            }),
          ]),
        );
        const source = request.evidence.sourceFiles.find(
          (candidate) => candidate.path === "instructions/system.md",
        );
        expect(source?.loaded).toBe(false);
        const admittedSource = request.evidence.runtimeActivation.admittedSourceFiles.find(
          (candidate) => candidate.path === "instructions/system.md",
        );
        expect(admittedSource?.loaded).toBe(true);
        expect(admittedSource?.content).not.toBe(source?.content);
        const anchor = source?.content.trimEnd().split("\n").at(-1);
        if (!anchor) throw new Error("Expected rebased instruction source evidence.");
        return hostedResult(request, {
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "propose",
          route: "prompt",
          operation: "update",
          target: "instructions/system.md",
          summary: "Encode a second reusable recovery.",
          evidenceBasis: singleEvidence(request),
          createContent: null,
          find: anchor,
          replace: `${anchor}\n\nPreserve completed work when applying a second harmless correction.`,
          expectedOutcome: "Later corrections preserve completed work.",
          reason: "The second recovered detour is independently reusable.",
        });
      },
    });

    expect(rebased.advanceReceipt?.decision).toBe("advanced");
    expect(rebased.proposal?.baseHarnessRelease).toEqual(
      first.workspace.currentChannel.release,
    );
    expect(rebased.proposal?.metadata.rebasedFromHarnessRelease).toEqual(
      stale.overlay.baseHarnessRelease,
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
      refine: async ({ request }) =>
        hostedResult(request, {
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "no_action",
            reason: "The failure was conversation-specific and does not justify a durable Harness change.",
        }),
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

  it("deduplicates concurrent invocations for the same durable trigger", async () => {
    const current = await fixture("run-concurrent-dedupe");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const refine = async ({ request }: { request: HostedHarnessRefinerRequest }) => {
      calls += 1;
      await gate;
      return hostedResult(request, {
        schemaVersion: "openpond.localHarnessRefinerDecision.v2",
        decision: "no_action",
        reason: "The concurrent fixture does not justify a durable change.",
      });
    };
    const workerInput = {
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      refine,
    };
    const first = runLocalHarnessRefinerWorker(workerInput);
    const second = runLocalHarnessRefinerWorker(workerInput);
    await Promise.resolve();
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(secondResult.outcome).toEqual(firstResult.outcome);
  });

  it("routes a measured fixture defect without converting the grade into Harness ownership", async () => {
    const current = await fixture("run-taskset-route");
    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      refine: async ({ request }) => hostedResult(request, {
        schemaVersion: "openpond.localHarnessRefinerDecision.v2",
        decision: "route",
        route: "taskset",
        summary: "The fixture contradicts the stated output contract.",
        evidenceBasis: singleEvidence(request),
        expectedOutcome: "The Taskset owner repairs and re-freezes the fixture.",
        reason: "The failed measurement is real, but its deterministic owner is the fixture.",
      }),
    });

    expect(result.proposal).toBeNull();
    expect(result.outcome).toMatchObject({
      decision: "no_action",
      metadata: {
        routed: true,
        route: "taskset",
        evidenceBasis: {
          kind: "single_deterministic",
          counterevidence: [],
        },
      },
    });
  });

  it("rejects an Agent proposal when the hosted request advertises no Agent capability", async () => {
    const current = await fixture("run-inactive-agent");

    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      refine: async ({ request }) =>
        hostedResult(request, {
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "agent",
            operation: "create",
            target: "agents/recovery-guide/agent.ts",
            summary: "Create a reusable recovery Agent.",
            evidenceBasis: singleEvidence(request),
            createContent: "export const agent = { name: 'recovery-guide' };\n",
            find: null,
            replace: null,
            expectedOutcome: "Future Desktop Work turns execute the recovery Agent.",
            reason: "The fixture verifies runtime activation fails closed.",
        }),
    });

    expect(result.outcome).toMatchObject({
      decision: "no_action",
      reason: expect.stringContaining("agent capability is unavailable"),
    });
    expect(result.proposal).toBeNull();
    expect(result.validations).toEqual([]);
    expect(result.advanceReceipt).toBeNull();
    expect(result.workspace.currentChannel).toEqual(current.workspace.currentChannel);
  });

  it("pins memory update revisions and applies the next revision atomically", async () => {
    const current = await fixture("run-memory-update");
    const first = await current.store.writeHarnessMemory({
      workspaceId: current.workspace.id,
      key: "brief-style",
      content: "Use short paragraphs.",
      expectedRevision: null,
      sourceRunId: null,
      sourceProposal: null,
      createdAt: NOW,
    });

    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      refine: async ({ request }) =>
        hostedResult(request, {
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "memory",
            operation: "update",
            target: "memory/brief-style",
            summary: "Keep briefs concise.",
            evidenceBasis: singleEvidence(request),
            createContent: null,
            find: "Use short paragraphs.",
            replace: "Use exactly three concise bullets when explicitly requested.",
            expectedOutcome: "Future requested briefs use the corrected style.",
            reason: "The user explicitly requested durable brief behavior.",
        }),
    });

    expect(result.proposal?.metadata.expectedMemory).toEqual({
      key: "brief-style",
      revision: first.revision,
      contentHash: first.contentHash,
      status: "active",
    });
    expect(result.validations.map((validation) => ({
      kind: validation.kind,
      status: validation.status,
      summary: validation.summary,
    }))).toEqual([
      expect.objectContaining({ kind: "observed_recovery", status: "passed" }),
      expect.objectContaining({ kind: "memory", status: "passed" }),
    ]);
    expect(result.applyReceipt?.decision).toBe("applied");
    expect(result.advanceReceipt).toBeNull();
    expect(await current.store.getHarnessMemory(current.workspace.id, "brief-style")).toMatchObject({
      revision: 2,
      content: "Use exactly three concise bullets when explicitly requested.",
      status: "active",
    });
  });

  it("requires review for memory deletion and rejects a stale deletion", async () => {
    const current = await fixture("run-memory-delete-conflict");
    const first = await current.store.writeHarnessMemory({
      workspaceId: current.workspace.id,
      key: "obsolete-style",
      content: "Use the obsolete style.",
      expectedRevision: null,
      sourceRunId: null,
      sourceProposal: null,
      createdAt: NOW,
    });
    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      refine: async ({ request }) =>
        hostedResult(request, {
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "memory",
            operation: "delete",
            target: "memory/obsolete-style",
            summary: "Remove the obsolete style.",
            evidenceBasis: singleEvidence(request),
            createContent: null,
            find: null,
            replace: null,
            expectedOutcome: "Future searches do not return the obsolete style.",
            reason: "The user explicitly requested removal.",
        }),
    });
    if (!result.proposal) throw new Error("Expected a retained memory proposal.");
    expect(result.validations.map((validation) => ({
      kind: validation.kind,
      status: validation.status,
      summary: validation.summary,
    }))).toEqual([
      expect.objectContaining({ kind: "memory", status: "passed" }),
    ]);
    expect(result.outcome.reason).toContain("requires explicit review");
    expect(result.applyReceipt?.decision).toBe("retained");
    expect(await current.store.getHarnessMemory(current.workspace.id, "obsolete-style")).toMatchObject({
      revision: 1,
      status: "active",
    });

    await current.store.writeHarnessMemory({
      workspaceId: current.workspace.id,
      key: "obsolete-style",
      content: "A newer value wins.",
      expectedRevision: first.revision,
      sourceRunId: null,
      sourceProposal: null,
      createdAt: "2026-08-05T20:03:00.000Z",
    });
    await expect(reviewLocalHarnessProposalFromSettings({
      store: current.store,
      storeDir: current.directory,
      request: {
        workspaceId: current.workspace.id,
        proposal: { id: result.proposal.id, contentHash: result.proposal.contentHash },
        decision: "approve",
      },
    })).rejects.toThrow(/changed concurrently/i);
    expect(await current.store.getHarnessMemory(current.workspace.id, "obsolete-style")).toMatchObject({
      revision: 2,
      content: "A newer value wins.",
      status: "active",
    });
  });

  it("deletes a pinned memory revision only after explicit review", async () => {
    const current = await fixture("run-memory-delete");
    const first = await current.store.writeHarnessMemory({
      workspaceId: current.workspace.id,
      key: "temporary-style",
      content: "Use this only during the temporary audit.",
      expectedRevision: null,
      sourceRunId: null,
      sourceProposal: null,
      createdAt: NOW,
    });
    const result = await runLocalHarnessRefinerWorker({
      store: current.store,
      storeDir: current.directory,
      trigger: current.trigger,
      signal: new AbortController().signal,
      now: () => LATER,
      refine: async ({ request }) =>
        hostedResult(request, {
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "memory",
            operation: "delete",
            target: "memory/temporary-style",
            summary: "Remove the temporary audit style.",
            evidenceBasis: singleEvidence(request),
            createContent: null,
            find: null,
            replace: null,
            expectedOutcome: "Future searches do not return the temporary audit style.",
            reason: "The temporary audit is complete.",
        }),
    });
    if (!result.proposal) throw new Error("Expected a retained memory proposal.");
    expect(result.proposal.metadata.expectedMemory).toEqual({
      key: "temporary-style",
      revision: first.revision,
      contentHash: first.contentHash,
      status: "active",
    });
    expect(result.outcome.reason).toContain("requires explicit review");

    const review = await reviewLocalHarnessProposalFromSettings({
      store: current.store,
      storeDir: current.directory,
      request: {
        workspaceId: current.workspace.id,
        proposal: { id: result.proposal.id, contentHash: result.proposal.contentHash },
        decision: "approve",
      },
    });

    expect(review.receipt.decision).toBe("applied");
    expect(await current.store.listHarnessMemories(current.workspace.id)).toEqual([]);
    expect(await current.store.getHarnessMemory(current.workspace.id, "temporary-style")).toMatchObject({
      revision: 2,
      content: "",
      status: "deleted",
    });
  });

  it("rejects an ambiguous update patch before freezing the run overlay", async () => {
    const current = await fixture("run-ambiguous-patch");

    await expect(
      runLocalHarnessRefinerWorker({
        store: current.store,
        storeDir: current.directory,
        trigger: current.trigger,
        signal: new AbortController().signal,
        now: () => LATER,
        refine: async ({ request }) =>
          hostedResult(request, {
              schemaVersion: "openpond.localHarnessRefinerDecision.v2",
              decision: "propose",
              route: "prompt",
              operation: "update",
              target: "instructions/system.md",
              summary: "Attempt an ambiguous patch.",
              evidenceBasis: singleEvidence(request),
              createContent: null,
              find: "\n",
              replace: "\n\n",
              expectedOutcome: "The exact intended location changes once.",
              reason: "This fixture verifies deterministic patch materialization.",
          }),
      }),
    ).rejects.toThrow(/must occur exactly once/i);

    expect(await current.store.getHarnessRunOverlay(current.trigger.runRef)).toEqual(
      current.overlay,
    );
  });
});
