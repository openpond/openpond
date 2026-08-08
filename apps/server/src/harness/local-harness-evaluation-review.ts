import {
  type HarnessEvaluationReviewReceipt,
  type HarnessReviewEvidenceRef,
  type ImprovementApplyReceipt,
  type ImprovementObservation,
  type ImprovementRouteDecision,
  type RefinementTriggerDecision,
} from "@openpond/contracts";
import {
  HarnessReviewWatermarkSchema,
  contentHash,
  createHarnessEvaluationReviewReceipt,
} from "@openpond/harness";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { resolveSelectedLocalHarnessRelease } from "./local-harness-selection.js";

const ReviewSourcePolicySchema = z.object({
  sourceRef: z.string().trim().min(1),
  policy: z.object({
    id: z.string().trim().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  state: z.enum(["authorized", "revoked", "deleted", "expired"]),
  checkedAt: z.string().datetime(),
}).strict();

export const LocalHarnessEvaluationReviewRequestSchema = z.object({
  previousWatermark: HarnessReviewWatermarkSchema.nullable().optional(),
  sourcePolicies: z.array(ReviewSourcePolicySchema).max(10_000).default([]),
  limits: z.object({
    maxEvidence: z.number().int().min(1).max(1_000).default(200),
    maxTokens: z.number().int().min(1).max(1_000_000).default(50_000),
    maxDurationMs: z.number().int().min(1).max(60_000).default(5_000),
    maxEstimatedCostUsd: z.number().finite().nonnegative().default(0),
  }).strict().default({
    maxEvidence: 200,
    maxTokens: 50_000,
    maxDurationMs: 5_000,
    maxEstimatedCostUsd: 0,
  }),
}).strict();

type ReviewRequest = z.infer<typeof LocalHarnessEvaluationReviewRequestSchema>;
type ReviewClassification = HarnessEvaluationReviewReceipt["classification"];

type Candidate = {
  route: ImprovementRouteDecision["route"];
  family: string;
  routeDecision: ImprovementRouteDecision;
  trigger: RefinementTriggerDecision;
  observation: ImprovementObservation | null;
  sourceRef: string;
};

export async function reviewSelectedLocalHarnessEvaluation(input: {
  store: SqliteStore;
  request: unknown;
  now?: () => string;
}): Promise<HarnessEvaluationReviewReceipt> {
  const request = LocalHarnessEvaluationReviewRequestSchema.parse(input.request ?? {});
  const startedAt = performance.now();
  const selectedRelease = await resolveSelectedLocalHarnessRelease(input.store);
  if (!selectedRelease) {
    throw new Error("No Local Harness release is selected for evaluation review.");
  }
  const workspace = await input.store.getHarnessWorkspace(selectedRelease.workspaceId);
  if (!workspace) {
    throw new Error(`Selected Harness workspace ${selectedRelease.workspaceId} does not exist.`);
  }

  const [reviews, routes, triggers, observations, applyReceipts] = await Promise.all([
    input.store.listHarnessImprovementArtifacts(workspace.id, "evaluation_review", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "route_decision", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "trigger_decision", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "observation", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "apply_receipt", 1_000),
  ]);
  const latestReview = (reviews as HarnessEvaluationReviewReceipt[])[0] ?? null;
  const previousWatermark = request.previousWatermark ?? latestReview?.nextWatermark ?? null;
  const typedRoutes = routes as ImprovementRouteDecision[];
  const typedTriggers = triggers as RefinementTriggerDecision[];
  const typedObservations = observations as ImprovementObservation[];
  const typedApplyReceipts = applyReceipts as ImprovementApplyReceipt[];
  if (
    request.previousWatermark === undefined &&
    latestReview &&
    !typedRoutes.some((route) => route.createdAt > latestReview.nextWatermark.throughCreatedAt)
  ) {
    return latestReview;
  }
  const triggerByRef = new Map(
    typedTriggers.map((trigger) => [artifactKey(trigger), trigger]),
  );
  const observationByRef = new Map(
    typedObservations.map((observation) => [artifactKey(observation), observation]),
  );
  const policyBySource = new Map(request.sourcePolicies.map((policy) => [policy.sourceRef, policy]));
  const excludedEvidence: HarnessEvaluationReviewReceipt["excludedEvidence"] = [];
  const candidates: Candidate[] = [];
  let examined = 0;
  let estimatedTokens = 0;

  for (const routeDecision of typedRoutes
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))) {
    if (performance.now() - startedAt >= request.limits.maxDurationMs) {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: null,
        reason: "budget",
      });
      continue;
    }
    if (previousWatermark && routeDecision.createdAt <= previousWatermark.throughCreatedAt) {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: null,
        reason: "before_watermark",
      });
      continue;
    }
    if (examined >= request.limits.maxEvidence) {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: null,
        reason: "budget",
      });
      continue;
    }
    examined += 1;
    const trigger = triggerByRef.get(artifactKey(routeDecision.trigger));
    if (!trigger) {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: null,
        reason: "unverified",
      });
      continue;
    }
    const observation = trigger.observations
      .map((reference) => observationByRef.get(artifactKey(reference)) ?? null)
      .find((candidate) => candidate !== null) ?? null;
    const proposalId = typeof routeDecision.metadata.proposalId === "string"
      ? routeDecision.metadata.proposalId
      : null;
    if (
      proposalId &&
      typedApplyReceipts.some((receipt) =>
        receipt.proposal.id === proposalId && receipt.decision === "applied",
      )
    ) {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: null,
        reason: "resolved",
      });
      continue;
    }
    const candidateTokens = Math.ceil(JSON.stringify({ routeDecision, trigger, observation }).length / 4);
    if (estimatedTokens + candidateTokens > request.limits.maxTokens) {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: null,
        reason: "budget",
      });
      continue;
    }
    estimatedTokens += candidateTokens;
    const sourceRef = observation?.runRef ?? trigger.runRef;
    const policy = policyBySource.get(sourceRef);
    if (!policy || policy.state !== "authorized") {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: policy ? sourcePolicyRef(policy) : null,
        reason: policy && policy.state !== "authorized" ? policy.state : "unverified",
      });
      continue;
    }
    candidates.push({
      route: routeDecision.route,
      family: recurrenceFamily(routeDecision.route, trigger, observation),
      routeDecision,
      trigger,
      observation,
      sourceRef,
    });
  }

  const deduplicated = deduplicateCandidates(candidates, excludedEvidence, policyBySource);
  const grouped = groupCandidates(deduplicated);
  const chosen = [...grouped.entries()]
    .map(([family, items]) => ({ family, items }))
    .sort((left, right) => right.items.length - left.items.length || left.family.localeCompare(right.family))[0] ?? null;
  const decision = classify(chosen?.items ?? []);
  const selectedEvidence = decision.classification === "no_action"
    ? []
    : (chosen?.items ?? []).map((candidate) => evidenceRef(candidate, policyBySource.get(candidate.sourceRef)!));
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const examinedCreatedAt = typedRoutes
    .filter((route) => !previousWatermark || route.createdAt > previousWatermark.throughCreatedAt)
    .slice(0, request.limits.maxEvidence)
    .map((route) => route.createdAt)
    .sort()
    .at(-1);
  const throughCreatedAt = maxTimestamp(previousWatermark?.throughCreatedAt, examinedCreatedAt, createdAt);
  const cursor = contentHash({
    previousCursor: previousWatermark?.cursor ?? null,
    throughCreatedAt,
    examined: typedRoutes
      .filter((route) => !previousWatermark || route.createdAt > previousWatermark.throughCreatedAt)
      .slice(0, request.limits.maxEvidence)
      .map(artifactRef),
  });
  const receiptId = `evaluation-review-${contentHash({
    workspaceId: workspace.id,
    harnessRelease: selectedRelease.harnessRelease,
    previousWatermark,
    cursor,
  }).slice(0, 24)}`;
  const receipt = createHarnessEvaluationReviewReceipt({
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1",
    id: receiptId,
    ownerScope: workspace.ownerScope,
    workspaceRef: workspace.id,
    harnessRelease: artifactRef(selectedRelease.harnessRelease),
    previousWatermark,
    nextWatermark: { cursor, throughCreatedAt },
    selectedEvidence,
    excludedEvidence,
    claim: decision.classification === "no_action" || !chosen ? null : {
      fingerprint: contentHash({ family: chosen.family, evidence: selectedEvidence.map((item) => item.occurrenceKey) }),
      recurrenceFamily: chosen.family,
      statement: decision.reason,
      independentOccurrences: new Set(chosen.items.map((item) => item.sourceRef)).size,
      unresolvedOccurrences: new Set(chosen.items.map((item) => item.sourceRef)).size,
    },
    classification: decision.classification,
    triage: decision.classification === "no_action" ? [] : [{
      layer: triageLayer(decision.classification),
      status: "unresolved",
      reason: decision.reason,
      evidenceRefs: selectedEvidence.map((item) => item.evidence),
    }],
    reason: decision.reason,
    nextAuthority: nextAuthority(decision.classification),
    maxEstimatedCostUsd: request.limits.maxEstimatedCostUsd,
    tasksetProposal: null,
    evaluation: null,
    trainingQualification: null,
    policyVersion: "local-harness-evaluation-review-v1",
    createdAt,
    metadata: {
      examinedEvidence: examined,
      estimatedTokens,
      elapsedMs: performance.now() - startedAt,
      explicitInvocation: true,
    },
  });
  await input.store.saveHarnessImprovementArtifact(workspace.id, "evaluation_review", receipt);
  return receipt;
}

function artifactRef(artifact: { id: string; contentHash: string }) {
  return { id: artifact.id, contentHash: artifact.contentHash };
}

function artifactKey(artifact: { id: string; contentHash: string }): string {
  return `${artifact.id}:${artifact.contentHash}`;
}

function sourcePolicyRef(policy: ReviewRequest["sourcePolicies"][number]) {
  return { policy: policy.policy, state: policy.state, checkedAt: policy.checkedAt };
}

function recurrenceFamily(
  route: ImprovementRouteDecision["route"],
  trigger: RefinementTriggerDecision,
  observation: ImprovementObservation | null,
): string {
  return [
    route,
    observation?.deterministicClass ?? "unclassified",
    observation?.tool?.name ?? trigger.deduplicationKey,
    observation?.state ?? "unknown-state",
  ].join(":");
}

function deduplicateCandidates(
  candidates: Candidate[],
  excluded: HarnessEvaluationReviewReceipt["excludedEvidence"],
  policies: Map<string, ReviewRequest["sourcePolicies"][number]>,
): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.family}:${candidate.sourceRef}`;
    if (!seen.has(key)) {
      seen.add(key);
      return true;
    }
    excluded.push({
      evidence: artifactRef(candidate.routeDecision),
      sourcePolicy: sourcePolicyRef(policies.get(candidate.sourceRef)!),
      reason: "duplicate",
    });
    return false;
  });
}

function groupCandidates(candidates: Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    groups.set(candidate.family, [...(groups.get(candidate.family) ?? []), candidate]);
  }
  return groups;
}

function evidenceRef(
  candidate: Candidate,
  policy: ReviewRequest["sourcePolicies"][number],
): HarnessReviewEvidenceRef {
  return {
    evidence: artifactRef(candidate.routeDecision),
    kind: "route_decision",
    sourceRef: candidate.sourceRef,
    sourcePolicy: sourcePolicyRef(policy),
    occurrenceKey: contentHash({ family: candidate.family, sourceRef: candidate.sourceRef }),
    occurredAt: candidate.routeDecision.createdAt,
  };
}

function classify(items: Candidate[]): { classification: ReviewClassification; reason: string } {
  if (items.length === 0) {
    return { classification: "no_action", reason: "No authorized unresolved evidence qualified for action." };
  }
  const route = items[0]!.route;
  if (route === "runtime") {
    return { classification: "runtime", reason: "Authorized unresolved evidence belongs to the runtime-service layer." };
  }
  if (route === "product") {
    return { classification: "product", reason: "Authorized unresolved evidence belongs to the product layer." };
  }
  if (route === "taskset" || route === "training") {
    if (items.length >= 3) {
      return { classification: "taskset", reason: "Three or more independent unresolved occurrences qualify for Taskset proposal review." };
    }
    return { classification: "no_action", reason: "Taskset evidence has not met the three-occurrence recurrence threshold." };
  }
  return { classification: "harness_maintenance", reason: "Authorized unresolved evidence belongs to Harness maintenance." };
}

function nextAuthority(classification: ReviewClassification): HarnessEvaluationReviewReceipt["nextAuthority"] {
  if (classification === "runtime") return "runtime_service";
  if (classification === "product") return "product_team";
  if (classification === "taskset") return "human_review";
  if (classification === "harness_maintenance") return "human_review";
  if (classification === "model_improvement") return "training_system";
  return "none";
}

function triageLayer(classification: ReviewClassification): HarnessEvaluationReviewReceipt["triage"][number]["layer"] {
  if (classification === "runtime") return "runtime";
  if (classification === "product") return "product";
  if (classification === "taskset") return "evaluation";
  if (classification === "model_improvement") return "model";
  return "harness";
}

function maxTimestamp(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1)!;
}
