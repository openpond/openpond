import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createImprovementObservation,
  createImprovementRouteDecision,
  createRefinementTriggerDecision,
  type HarnessImprovementRoute,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";
import { reviewSelectedLocalHarnessEvaluation } from "./local-harness-evaluation-review.js";
import { localHarnessHistoryPayload } from "./local-harness-history.js";
import { createLocalHarnessWorkspace } from "./local-harness-workspace-service.js";

const NOW = "2026-08-08T12:00:00.000Z";
const cleanup: Array<{ directory: string; store: SqliteStore }> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async ({ directory, store }) => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-evaluation-review-"));
  const store = new SqliteStore(directory);
  cleanup.push({ directory, store });
  const created = await createLocalHarnessWorkspace({
    store,
    storeDir: directory,
    id: "personal-review",
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
  return { store, ...created };
}

async function saveOccurrence(input: {
  store: SqliteStore;
  workspaceId: string;
  harnessRelease: { id: string; contentHash: string };
  route: HarnessImprovementRoute;
  runRef: string;
  createdAt: string;
}) {
  const harnessRelease = {
    id: input.harnessRelease.id,
    contentHash: input.harnessRelease.contentHash,
  };
  const observation = createImprovementObservation({
    schemaVersion: "openpond.improvementObservation.v1",
    id: `observation-${input.runRef}`,
    runRef: input.runRef,
    turnId: `turn-${input.runRef}`,
    harnessRelease,
    overlay: null,
    eventRefs: [{
      id: `event-${input.runRef}`,
      sequence: 1,
      contentHash: contentHash({ runRef: input.runRef, event: 1 }),
    }],
    kind: "validation",
    state: "open",
    tool: null,
    deterministicClass: "answer-quality-regression",
    summary: "A repeatable answer-quality regression remained unresolved.",
    createdAt: input.createdAt,
    metadata: {},
  });
  const trigger = createRefinementTriggerDecision({
    schemaVersion: "openpond.refinementTriggerDecision.v1",
    id: `trigger-${input.runRef}`,
    runRef: input.runRef,
    turnId: `turn-${input.runRef}`,
    harnessRelease,
    overlay: null,
    observations: [{ id: observation.id, contentHash: observation.contentHash }],
    decision: "route_deterministically",
    deterministicRoute: input.route,
    suggestedRoutes: [input.route],
    reason: "Route persisted evidence for bounded evaluation review.",
    deduplicationKey: contentHash({ family: "answer-quality-regression" }),
    policy: {
      schemaVersion: "openpond.refinementTriggerPolicy.v1",
      maxEstimatedCostUsd: 0,
      cooldownMs: 0,
      maxPendingPlans: 10,
      maxEvidenceEvents: 100,
      maxProposalEdits: 10,
      maxProposalBytes: 100_000,
    },
    estimatedMaxCostUsd: 0,
    pendingPlanCount: 0,
    boundary: { kind: "turn_completed", eventSequence: 1, occurredAt: input.createdAt },
    cooldownUntil: null,
    createdAt: input.createdAt,
    metadata: {},
  });
  const route = createImprovementRouteDecision({
    schemaVersion: "openpond.improvementRouteDecision.v1",
    id: `route-${input.runRef}`,
    trigger: { id: trigger.id, contentHash: trigger.contentHash },
    route: input.route,
    authority: input.route === "runtime" ? "runtime_service" : "human_review",
    automatic: input.route === "runtime",
    reason: "Persisted deterministic routing evidence.",
    createdAt: input.createdAt,
    metadata: {},
  });
  await input.store.saveHarnessImprovementArtifact(input.workspaceId, "observation", observation);
  await input.store.saveHarnessImprovementArtifact(input.workspaceId, "trigger_decision", trigger);
  await input.store.saveHarnessImprovementArtifact(input.workspaceId, "route_decision", route);
}

function sourcePolicies(runRefs: string[], state: "authorized" | "revoked" = "authorized") {
  return runRefs.map((sourceRef) => ({
    sourceRef,
    policy: { id: `policy-${sourceRef}`, contentHash: contentHash({ sourceRef, policy: 1 }) },
    state,
    checkedAt: NOW,
  }));
}

describe("local Harness evaluation review", () => {
  it("persists one idempotent no-action receipt for an empty bounded window", async () => {
    const current = await fixture();
    const first = await reviewSelectedLocalHarnessEvaluation({
      store: current.store,
      request: {},
      now: () => "2026-08-08T12:10:00.000Z",
    });
    const second = await reviewSelectedLocalHarnessEvaluation({
      store: current.store,
      request: {},
      now: () => "2026-08-08T12:11:00.000Z",
    });

    expect(first.classification).toBe("no_action");
    expect(second.contentHash).toBe(first.contentHash);
    expect((await localHarnessHistoryPayload(current.store)).evaluationReviews).toHaveLength(1);
  });

  it("routes authorized runtime evidence and excludes revoked evidence", async () => {
    const current = await fixture();
    await saveOccurrence({
      store: current.store,
      workspaceId: current.workspace.id,
      harnessRelease: current.release.harnessRelease,
      route: "runtime",
      runRef: "run-runtime",
      createdAt: "2026-08-08T12:01:00.000Z",
    });
    const receipt = await reviewSelectedLocalHarnessEvaluation({
      store: current.store,
      request: { sourcePolicies: sourcePolicies(["run-runtime"]) },
      now: () => "2026-08-08T12:10:00.000Z",
    });
    expect(receipt).toMatchObject({
      classification: "runtime",
      nextAuthority: "runtime_service",
    });
    expect(receipt.selectedEvidence).toHaveLength(1);

    const revoked = await fixture();
    await saveOccurrence({
      store: revoked.store,
      workspaceId: revoked.workspace.id,
      harnessRelease: revoked.release.harnessRelease,
      route: "runtime",
      runRef: "run-revoked",
      createdAt: "2026-08-08T12:01:00.000Z",
    });
    const blocked = await reviewSelectedLocalHarnessEvaluation({
      store: revoked.store,
      request: { sourcePolicies: sourcePolicies(["run-revoked"], "revoked") },
      now: () => "2026-08-08T12:10:00.000Z",
    });
    expect(blocked.classification).toBe("no_action");
    expect(blocked.excludedEvidence).toContainEqual(expect.objectContaining({ reason: "revoked" }));
  });

  it("requires three independent occurrences before proposing Taskset work", async () => {
    const current = await fixture();
    const runRefs = ["run-one", "run-two", "run-three"];
    for (const [index, runRef] of runRefs.entries()) {
      await saveOccurrence({
        store: current.store,
        workspaceId: current.workspace.id,
        harnessRelease: current.release.harnessRelease,
        route: "training",
        runRef,
        createdAt: `2026-08-08T12:0${index + 1}:00.000Z`,
      });
    }
    const receipt = await reviewSelectedLocalHarnessEvaluation({
      store: current.store,
      request: { sourcePolicies: sourcePolicies(runRefs), limits: { maxEvidence: 3 } },
      now: () => "2026-08-08T12:10:00.000Z",
    });
    expect(receipt).toMatchObject({
      classification: "taskset",
      nextAuthority: "human_review",
      claim: { independentOccurrences: 3, unresolvedOccurrences: 3 },
    });
    expect(receipt.selectedEvidence).toHaveLength(3);
  });
});
