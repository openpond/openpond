import {
  createRefinementTriggerDecision,
  type HarnessEvaluationReviewReceipt,
  type HarnessRefinementCandidate,
  type HarnessRefinerOutcome,
  type ImprovementObservation,
  type ImprovementRouteDecision,
  type RefinementTriggerDecision,
} from "@openpond/contracts";
import {
  createHarnessCrossRunRefinementRequest,
  harnessCrossRunRefinementDeduplicationKey,
  type HarnessEvaluationReviewModelStream,
} from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import { ensureLocalHarnessRunOverlay } from "./local-harness-run-overlay.js";
import { recordAppliedLocalHarnessRefinementCandidate } from "./local-harness-refinement-candidates.js";
import {
  runLocalHarnessRefinerWorker,
  type LocalHarnessRefinerWorkerResult,
} from "./local-harness-refiner-worker.js";

const CAPABILITIES = {
  memory: true,
  prompt: true,
  skill: true,
  agent: false,
} as const;

export type LocalHarnessCrossRunRefinementResult = {
  candidate: HarnessRefinementCandidate;
  worker: LocalHarnessRefinerWorkerResult;
};

export async function continueConfirmedLocalHarnessCandidate(input: {
  store: SqliteStore;
  storeDir: string;
  candidate: HarnessRefinementCandidate;
  review: HarnessEvaluationReviewReceipt;
  stream: HarnessEvaluationReviewModelStream;
  signal: AbortSignal;
  now?: () => string;
}): Promise<LocalHarnessCrossRunRefinementResult | null> {
  if (input.candidate.status !== "confirmed") return null;
  if (
    input.review.classification !== "harness_maintenance" ||
    input.review.contentHash !== input.candidate.sourceReviews.at(-1)?.contentHash
  ) {
    throw new Error("Cross-run continuation requires the candidate's confirming Harness review.");
  }
  const workspace = await input.store.getHarnessWorkspace(input.candidate.workspaceRef);
  const admittedHarness = workspace?.currentChannel.release ?? null;
  if (!workspace || workspace.location !== "local" || !admittedHarness) {
    throw new Error("Cross-run continuation requires an active Local Harness release.");
  }
  const deduplicationKey = harnessCrossRunRefinementDeduplicationKey({
    workspaceRef: workspace.id,
    candidateFingerprint: input.candidate.fingerprint,
    admittedHarness,
  });
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const request = createHarnessCrossRunRefinementRequest({
    schemaVersion: "openpond.harnessCrossRunRefinementRequest.v1",
    id: `cross-run-refinement-${deduplicationKey.slice(0, 24)}`,
    ownerScope: workspace.ownerScope,
    workspaceRef: workspace.id,
    candidate: artifactRef(input.candidate),
    candidateFingerprint: input.candidate.fingerprint,
    review: artifactRef(input.review),
    admittedHarness,
    evidence: input.candidate.occurrences,
    capabilities: CAPABILITIES,
    deduplicationKey,
    createdAt: timestamp,
  });
  const persisted = await input.store.saveHarnessCrossRunRefinementRequestIfAbsent({
    workspaceId: workspace.id,
    request,
  });
  if (!persisted.created) return null;
  const observations = await resolveCandidateObservations(
    input.store,
    workspace.id,
    persisted.request.evidence,
  );
  if (observations.length === 0) {
    throw new Error("Confirmed cross-run candidate has no verifiable source observations.");
  }
  const runRef = `cross-run-${persisted.request.deduplicationKey.slice(0, 24)}`;
  const overlay = await ensureLocalHarnessRunOverlay({
    store: input.store,
    runId: runRef,
    workspace,
    harnessRelease: persisted.request.admittedHarness,
    admittedAt: persisted.request.createdAt,
  });
  const trigger = createCrossRunTrigger({
    request: persisted.request,
    overlay,
    observations,
  });
  await input.store.saveHarnessImprovementArtifact(
    workspace.id,
    "trigger_decision",
    trigger,
  );
  const worker = await runLocalHarnessRefinerWorker({
    store: input.store,
    storeDir: input.storeDir,
    trigger,
    additionalEvidence: {
      reviewScope: "cross_run_candidate",
      request: persisted.request,
      candidate: input.candidate,
      review: input.review,
    },
    reviewScope: "cross_run_candidate",
    stream: input.stream,
    signal: input.signal,
    now: input.now,
  });
  let candidate = input.candidate;
  if (worker.applyReceipt?.decision === "applied") {
    candidate = await recordAppliedLocalHarnessRefinementCandidate({
      store: input.store,
      candidate,
      review: input.review,
      relatedHarnessRelease: worker.workspace.currentChannel.release ?? null,
      reason: "The confirmed candidate produced a validated applied Harness change and now awaits independent outcome evidence.",
      now: (input.now ?? (() => new Date().toISOString()))(),
    });
  }
  return { candidate, worker };
}

function createCrossRunTrigger(input: {
  request: ReturnType<typeof createHarnessCrossRunRefinementRequest>;
  overlay: Awaited<ReturnType<typeof ensureLocalHarnessRunOverlay>>;
  observations: ImprovementObservation[];
}): RefinementTriggerDecision {
  const observationRefs = input.observations.slice(0, 100).map(artifactRef);
  return createRefinementTriggerDecision({
    schemaVersion: "openpond.refinementTriggerDecision.v1",
    id: `cross-run-trigger-${input.request.deduplicationKey.slice(0, 24)}`,
    runRef: input.overlay.runId,
    turnId: `candidate-${input.request.candidate.id}`,
    harnessRelease: input.request.admittedHarness,
    overlay: {
      id: input.overlay.id,
      revision: input.overlay.revision,
      contentHash: input.overlay.contentHash,
    },
    observations: observationRefs,
    decision: "queue_refiner",
    deterministicRoute: null,
    suggestedRoutes: [],
    reason: "A confirmed authorized cross-Work candidate is ready for one bounded Refiner continuation.",
    deduplicationKey: input.request.deduplicationKey,
    policy: {
      schemaVersion: "openpond.refinementTriggerPolicy.v1",
      maxEstimatedCostUsd: 0.05,
      cooldownMs: 0,
      maxPendingPlans: 1,
      maxEvidenceEvents: 100,
      maxProposalEdits: 4,
      maxProposalBytes: 20_000,
    },
    estimatedMaxCostUsd: 0.05,
    pendingPlanCount: 0,
    boundary: {
      kind: "turn_completed",
      eventSequence: 0,
      occurredAt: input.request.createdAt,
    },
    cooldownUntil: null,
    createdAt: input.request.createdAt,
    metadata: {
      origin: "cross_run_candidate",
      crossRunRefinementRequest: artifactRef(input.request),
      candidate: input.request.candidate,
    },
  });
}

async function resolveCandidateObservations(
  store: SqliteStore,
  workspaceId: string,
  evidence: HarnessRefinementCandidate["occurrences"],
): Promise<ImprovementObservation[]> {
  const [observations, triggers, routes, outcomes] = await Promise.all([
    store.listHarnessImprovementArtifacts(workspaceId, "observation", 1_000),
    store.listHarnessImprovementArtifacts(workspaceId, "trigger_decision", 1_000),
    store.listHarnessImprovementArtifacts(workspaceId, "route_decision", 1_000),
    store.listHarnessImprovementArtifacts(workspaceId, "refiner_outcome", 1_000),
  ]) as [
    ImprovementObservation[],
    RefinementTriggerDecision[],
    ImprovementRouteDecision[],
    HarnessRefinerOutcome[],
  ];
  const observationByRef = new Map(observations.map((item) => [artifactKey(item), item]));
  const triggerByRef = new Map(triggers.map((item) => [artifactKey(item), item]));
  const routeByRef = new Map(routes.map((item) => [artifactKey(item), item]));
  const outcomeByRef = new Map(outcomes.map((item) => [artifactKey(item), item]));
  const resolved = new Map<string, ImprovementObservation>();
  for (const occurrence of evidence) {
    if (occurrence.kind === "observation") {
      const observation = observationByRef.get(artifactKey(occurrence.evidence));
      if (observation) resolved.set(artifactKey(observation), observation);
      continue;
    }
    const triggerRef = occurrence.kind === "route_decision"
      ? routeByRef.get(artifactKey(occurrence.evidence))?.trigger
      : occurrence.kind === "refiner_outcome"
        ? outcomeByRef.get(artifactKey(occurrence.evidence))?.trigger
        : null;
    const trigger = triggerRef ? triggerByRef.get(artifactKey(triggerRef)) : null;
    for (const ref of trigger?.observations ?? []) {
      const observation = observationByRef.get(artifactKey(ref));
      if (observation) resolved.set(artifactKey(observation), observation);
    }
  }
  return [...resolved.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function artifactRef(artifact: { id: string; contentHash: string }) {
  return { id: artifact.id, contentHash: artifact.contentHash };
}

function artifactKey(artifact: { id: string; contentHash: string }): string {
  return `${artifact.id}:${artifact.contentHash}`;
}
