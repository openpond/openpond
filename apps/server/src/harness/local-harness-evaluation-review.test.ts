import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createImprovementObservation,
  createImprovementRouteDecision,
  createRefinementTriggerDecision,
  type HarnessImprovementRoute,
} from "@openpond/contracts";
import {
  contentHash,
  type HarnessEvaluationReviewModelDecision,
  type HarnessEvaluationReviewModelStream,
} from "@openpond/harness";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";
import { reviewSelectedLocalHarnessEvaluation } from "./local-harness-evaluation-review.js";
import {
  localHarnessHistoryPayload,
  reviewLocalHarnessEvaluationFromSettings,
  updateLocalHarnessEvaluationReviewScheduleFromSettings,
} from "./local-harness-history.js";
import { createLocalHarnessEvaluationReviewScheduler } from "./local-harness-evaluation-review-scheduler.js";
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

function reviewStream(
  decision: HarnessEvaluationReviewModelDecision,
): HarnessEvaluationReviewModelStream {
  return async function* () {
    yield { text: JSON.stringify(decision) };
  };
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
      stream: reviewStream({
        schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
        decision: "review",
        classification: "runtime",
        selectedEvidenceIds: ["route_decision:route-run-runtime"],
        ignoredEvidence: [],
        recurrenceFamily: "supported-runtime-capability-failure",
        statement: "The supported runtime capability failed during work.",
        triageLayer: "runtime",
        expectedOutcome: "Restore the supported runtime capability.",
        counterevidence: "",
        confidence: 0.94,
        reason: "The authorized evidence directly identifies a runtime failure.",
      }),
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

  it("lets the model select semantically related evidence for Taskset work", async () => {
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
      stream: reviewStream({
        schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
        decision: "review",
        classification: "taskset",
        selectedEvidenceIds: runRefs.map((runRef) => `route_decision:route-${runRef}`),
        ignoredEvidence: [],
        recurrenceFamily: "answer-quality-regression",
        statement: "Independent turns show a related answer-quality regression.",
        triageLayer: "evaluation",
        expectedOutcome: "Measure the behavior under a controlled Taskset before escalation.",
        counterevidence: "The surface wording differs across turns.",
        confidence: 0.86,
        reason: "The evidence is semantically related and needs controlled measurement.",
      }),
      now: () => "2026-08-08T12:10:00.000Z",
    });
    expect(receipt).toMatchObject({
      classification: "taskset",
      nextAuthority: "human_review",
      claim: { independentOccurrences: 3, unresolvedOccurrences: 3 },
    });
    expect(receipt.selectedEvidence).toHaveLength(3);
  });

  it("does not watermark evidence that a review budget has not examined", async () => {
    const current = await fixture();
    const runRefs = ["run-budget-one", "run-budget-two"];
    for (const [index, runRef] of runRefs.entries()) {
      await saveOccurrence({
        store: current.store,
        workspaceId: current.workspace.id,
        harnessRelease: current.release.harnessRelease,
        route: "runtime",
        runRef,
        createdAt: `2026-08-08T12:0${index + 1}:00.000Z`,
      });
    }
    const first = await reviewSelectedLocalHarnessEvaluation({
      store: current.store,
      request: { sourcePolicies: sourcePolicies(runRefs), limits: { maxEvidence: 1 } },
      stream: reviewStream({
        schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
        decision: "no_action",
        reason: "The first bounded candidate alone is insufficient.",
        ignoredEvidence: [{
          id: "route_decision:route-run-budget-one",
          reason: "Review the next independent occurrence in a later bounded window.",
        }],
      }),
      now: () => "2026-08-08T12:10:00.000Z",
    });
    expect(first.nextWatermark.throughCreatedAt).toBe("2026-08-08T12:01:00.000Z");

    const second = await reviewSelectedLocalHarnessEvaluation({
      store: current.store,
      request: { sourcePolicies: sourcePolicies(runRefs), limits: { maxEvidence: 1 } },
      stream: reviewStream({
        schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
        decision: "review",
        classification: "runtime",
        selectedEvidenceIds: ["route_decision:route-run-budget-two"],
        ignoredEvidence: [],
        recurrenceFamily: "supported-runtime-capability-failure",
        statement: "A later independent occurrence remains available for review.",
        triageLayer: "runtime",
        expectedOutcome: "Repair the supported runtime capability.",
        counterevidence: "The first bounded review did not see this occurrence.",
        confidence: 0.9,
        reason: "Budget exclusion must defer evidence rather than consume it.",
      }),
      now: () => "2026-08-08T12:11:00.000Z",
    });
    expect(second).toMatchObject({
      classification: "runtime",
      selectedEvidence: [
        { evidence: { id: "route-run-budget-two" } },
      ],
    });
  });

  it("defers evidence the model did not select for full review and aggregates staged usage", async () => {
    const current = await fixture();
    const runRefs = Array.from({ length: 20 }, (_, index) => `run-navigation-${index + 1}`);
    for (const [index, runRef] of runRefs.entries()) {
      await saveOccurrence({
        store: current.store,
        workspaceId: current.workspace.id,
        harnessRelease: current.release.harnessRelease,
        route: "runtime",
        runRef,
        createdAt: `2026-08-08T12:00:${String(index + 1).padStart(2, "0")}.000Z`,
      });
    }
    let calls = 0;
    const receipt = await reviewSelectedLocalHarnessEvaluation({
      store: current.store,
      request: {
        sourcePolicies: sourcePolicies(runRefs),
        limits: { maxEvidence: 20, maxTokens: 100_000 },
      },
      stream: async function* ({ messages }) {
        calls += 1;
        if (calls === 1) {
          expect(messages[0]!.content).toContain("navigating a bounded set");
          yield {
            text: JSON.stringify({
              schemaVersion: "openpond.harnessEvaluationReviewNavigationDecision.v1",
              selectedEvidenceIds: [
                "route_decision:route-run-navigation-1",
                "route_decision:route-run-navigation-2",
              ],
              reason: "Inspect the first two related runtime occurrences in full.",
            }),
            usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          };
          return;
        }
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
            decision: "no_action",
            reason: "The two fully reviewed occurrences are not yet enough for durable routing.",
            ignoredEvidence: [
              {
                id: "route_decision:route-run-navigation-1",
                reason: "Keep as counterevidence.",
              },
              {
                id: "route_decision:route-run-navigation-2",
                reason: "Keep as counterevidence.",
              },
            ],
          }),
          usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
        };
      },
      now: () => "2026-08-08T12:10:00.000Z",
    });

    expect(calls).toBe(2);
    expect(receipt.nextWatermark.throughCreatedAt).toBe("2026-08-08T12:00:02.000Z");
    expect(receipt.excludedEvidence).toContainEqual(expect.objectContaining({
      evidence: { id: "route-run-navigation-3", contentHash: expect.any(String) },
      reason: "budget",
    }));
    expect(receipt.metadata).toMatchObject({
      fullyReviewedEvidence: 2,
      modelUsage: { promptTokens: 300, completionTokens: 30, totalTokens: 330 },
    });
  });

  it("joins concurrent manual and scheduled reviews for one Local store", async () => {
    const current = await fixture();
    await saveOccurrence({
      store: current.store,
      workspaceId: current.workspace.id,
      harnessRelease: current.release.harnessRelease,
      route: "runtime",
      runRef: "run-concurrent",
      createdAt: "2026-08-08T12:01:00.000Z",
    });
    let modelCalls = 0;
    const stream: HarnessEvaluationReviewModelStream = async function* () {
      modelCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield { text: JSON.stringify({
        schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
        decision: "no_action",
        reason: "One occurrence does not yet justify durable work.",
        ignoredEvidence: [{
          id: "route_decision:route-run-concurrent",
          reason: "Retain the immutable occurrence for later cross-task review.",
        }],
      }) };
    };
    const request = { sourcePolicies: sourcePolicies(["run-concurrent"]) };
    const [manual, scheduled] = await Promise.all([
      reviewSelectedLocalHarnessEvaluation({
        store: current.store,
        request,
        stream,
        now: () => "2026-08-08T12:10:00.000Z",
      }),
      reviewSelectedLocalHarnessEvaluation({
        store: current.store,
        request,
        stream,
        now: () => "2026-08-08T12:10:01.000Z",
      }),
    ]);
    expect(modelCalls).toBe(1);
    expect(scheduled.contentHash).toBe(manual.contentHash);
    expect((await localHarnessHistoryPayload(current.store)).evaluationReviews).toHaveLength(1);
  });

  it("persists explicit review status and schedule controls in Harness history", async () => {
    const current = await fixture();
    const reviewed = await reviewLocalHarnessEvaluationFromSettings({
      store: current.store,
      request: { workspaceId: current.workspace.id, maxEstimatedCostUsd: 1.25 },
    });
    expect(reviewed.history.evaluationReviewSchedule.lastResult).toMatchObject({
      id: reviewed.receipt.id,
      contentHash: reviewed.receipt.contentHash,
      classification: "no_action",
    });

    const scheduled = await updateLocalHarnessEvaluationReviewScheduleFromSettings({
      store: current.store,
      request: {
        workspaceId: current.workspace.id,
        enabled: true,
        cadence: "daily",
        maxEstimatedCostUsd: 2,
      },
    });
    expect(scheduled.history.evaluationReviewSchedule).toMatchObject({
      enabled: true,
      cadence: "daily",
      maxEstimatedCostUsd: 2,
    });
    expect(scheduled.history.evaluationReviewSchedule.nextRunAt).not.toBeNull();
  });

  it("runs due schedules through the same idempotent review operation", async () => {
    const current = await fixture();
    await current.store.setHarnessEvaluationReviewSettings({
      workspaceId: current.workspace.id,
      settings: {
        enabled: true,
        cadence: "daily",
        maxEstimatedCostUsd: 0.5,
        nextRunAt: "2026-08-08T11:59:00.000Z",
        lastRunAt: null,
        lastResult: null,
        lastError: null,
        updatedAt: "2026-08-08T11:58:00.000Z",
      },
    });
    const scheduler = createLocalHarnessEvaluationReviewScheduler({
      store: current.store,
      isClosing: () => false,
      now: () => NOW,
    });
    const receipt = await scheduler.runDueNow();
    expect(receipt?.classification).toBe("no_action");
    expect(receipt?.maxEstimatedCostUsd).toBe(0.5);
    expect(await current.store.getHarnessEvaluationReviewSettings(current.workspace.id)).toMatchObject({
      nextRunAt: "2026-08-09T12:00:00.000Z",
      lastRunAt: NOW,
      lastResult: { id: receipt?.id, contentHash: receipt?.contentHash },
      lastError: null,
    });
    expect(await scheduler.runDueNow()).toBeNull();
  });
});
