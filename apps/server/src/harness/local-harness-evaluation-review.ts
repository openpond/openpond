import {
  type HarnessEvaluationReviewReceipt,
  type HarnessReviewEvidenceRef,
  type HarnessRefinerOutcome,
  type ImprovementApplyReceipt,
  type ImprovementObservation,
  type ImprovementRouteDecision,
  type RefinementTriggerDecision,
  type RuntimeEvent,
} from "@openpond/contracts";
import {
  authorHarnessEvaluationReviewWithModel,
  HarnessReviewWatermarkSchema,
  contentHash,
  createHarnessEvaluationReviewReceipt,
  type HarnessEvaluationReviewModelDecision,
  type HarnessEvaluationReviewModelStream,
} from "@openpond/harness";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { resolveSelectedLocalHarnessRelease } from "./local-harness-selection.js";
import { inspectBoundedPdfArtifactDiagnostics } from "./local-harness-refiner-context.js";

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
    maxDurationMs: z.number().int().min(1).max(300_000).default(240_000),
    maxEstimatedCostUsd: z.number().finite().nonnegative().default(0.1),
  }).strict().default({
    maxEvidence: 200,
    maxTokens: 50_000,
    maxDurationMs: 240_000,
    maxEstimatedCostUsd: 0.1,
  }),
}).strict();

type ReviewRequest = z.infer<typeof LocalHarnessEvaluationReviewRequestSchema>;
type ReviewClassification = HarnessEvaluationReviewReceipt["classification"];

type Candidate = {
  id: string;
  artifact: { id: string; contentHash: string; createdAt: string };
  kind: HarnessReviewEvidenceRef["kind"];
  sourceRef: string;
  payload: Record<string, unknown>;
};

const activeReviews = new WeakMap<SqliteStore, Promise<HarnessEvaluationReviewReceipt>>();

export function reviewSelectedLocalHarnessEvaluation(input: {
  store: SqliteStore;
  request: unknown;
  stream?: HarnessEvaluationReviewModelStream;
  signal?: AbortSignal;
  now?: () => string;
}): Promise<HarnessEvaluationReviewReceipt> {
  const active = activeReviews.get(input.store);
  if (active) return active;
  const review = runSelectedLocalHarnessEvaluation(input).finally(() => {
    if (activeReviews.get(input.store) === review) activeReviews.delete(input.store);
  });
  activeReviews.set(input.store, review);
  return review;
}

async function runSelectedLocalHarnessEvaluation(input: {
  store: SqliteStore;
  request: unknown;
  stream?: HarnessEvaluationReviewModelStream;
  signal?: AbortSignal;
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

  const [reviews, routes, triggers, observations, applyReceipts, outcomes] = await Promise.all([
    input.store.listHarnessImprovementArtifacts(workspace.id, "evaluation_review", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "route_decision", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "trigger_decision", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "observation", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "apply_receipt", 1_000),
    input.store.listHarnessImprovementArtifacts(workspace.id, "refiner_outcome", 1_000),
  ]);
  const latestReview = (reviews as HarnessEvaluationReviewReceipt[])[0] ?? null;
  const previousWatermark = request.previousWatermark ?? latestReview?.nextWatermark ?? null;
  const typedRoutes = routes as ImprovementRouteDecision[];
  const typedTriggers = triggers as RefinementTriggerDecision[];
  const typedObservations = observations as ImprovementObservation[];
  const typedApplyReceipts = applyReceipts as ImprovementApplyReceipt[];
  const typedOutcomes = outcomes as HarnessRefinerOutcome[];
  const allArtifacts = [
    ...typedRoutes,
    ...typedObservations,
    ...typedOutcomes,
  ];
  if (
    request.previousWatermark === undefined &&
    latestReview &&
    !allArtifacts.some((artifact) => artifact.createdAt > latestReview.nextWatermark.throughCreatedAt)
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
  const rawCandidates: Candidate[] = [];
  const representedObservationKeys = new Set<string>();
  const routedTriggerKeys = new Set(typedRoutes.map((route) => artifactKey(route.trigger)));
  const eventsBySource = new Map<
    string,
    Awaited<ReturnType<SqliteStore["runtimeEventsForSession"]>>
  >();
  const artifactDiagnosticsBySource = new Map<
    string,
    Awaited<ReturnType<typeof inspectBoundedPdfArtifactDiagnostics>>
  >();
  const contextForObservation = async (observation: ImprovementObservation) => {
    let sourceEvents = eventsBySource.get(observation.runRef);
    if (!sourceEvents) {
      sourceEvents = await input.store.runtimeEventsForSession(observation.runRef);
      eventsBySource.set(observation.runRef, sourceEvents);
    }
    const turnEvents = sourceEvents.filter((event) => event.turnId === observation.turnId);
    const [turn, session] = await Promise.all([
      input.store.getTurn(observation.turnId),
      input.store.getSession(observation.runRef),
    ]);
    let artifactDiagnostics = artifactDiagnosticsBySource.get(observation.runRef);
    if (!artifactDiagnostics) {
      artifactDiagnostics = await inspectBoundedPdfArtifactDiagnostics(session?.cwd);
      artifactDiagnosticsBySource.set(observation.runRef, artifactDiagnostics);
    }
    return {
      turn: turn ? {
        id: turn.id,
        prompt: boundedReviewText(turn.prompt, 2_000),
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        status: turn.status,
        error: boundedReviewText(turn.error ?? "", 1_000),
      } : null,
      assistantOutput: boundedReviewText(
        turnEvents
          .filter((event) => event.name === "assistant.delta")
          .map((event) => event.output ?? "")
          .join(""),
        6_000,
      ),
      artifactDiagnostics,
      events: turnEvents
        .filter((event) => [
          "tool.completed",
          "validation.completed",
          "workspace_action_result",
        ].includes(event.name))
        .filter((event) =>
          event.status === "failed" ||
          ["validation.completed", "workspace_action_result"].includes(event.name),
        )
        .slice(-8)
        .map(boundedReviewEvent),
    };
  };
  for (const routeDecision of typedRoutes) {
    const trigger = triggerByRef.get(artifactKey(routeDecision.trigger));
    if (!trigger) {
      excludedEvidence.push({
        evidence: artifactRef(routeDecision),
        sourcePolicy: null,
        reason: "unverified",
      });
      continue;
    }
    const linkedObservations = trigger.observations
      .map((reference) => observationByRef.get(artifactKey(reference)))
      .filter((value): value is ImprovementObservation => Boolean(value));
    for (const observation of linkedObservations) {
      representedObservationKeys.add(artifactKey(observation));
    }
    rawCandidates.push({
      id: `route_decision:${routeDecision.id}`,
      artifact: routeDecision,
      kind: "route_decision",
      sourceRef: linkedObservations[0]?.runRef ?? trigger.runRef,
      payload: {
        routeDecision,
        trigger,
        observations: linkedObservations,
        turnContexts: await uniqueTurnContexts(linkedObservations, contextForObservation),
      },
    });
  }
  for (const outcome of typedOutcomes) {
    if (routedTriggerKeys.has(artifactKey(outcome.trigger))) continue;
    const trigger = triggerByRef.get(artifactKey(outcome.trigger));
    if (!trigger) {
      excludedEvidence.push({
        evidence: artifactRef(outcome),
        sourcePolicy: null,
        reason: "unverified",
      });
      continue;
    }
    const linkedObservations = trigger.observations
      .map((reference) => observationByRef.get(artifactKey(reference)))
      .filter((value): value is ImprovementObservation => Boolean(value));
    for (const observation of linkedObservations) {
      representedObservationKeys.add(artifactKey(observation));
    }
    const linkedApplyReceipts = outcome.proposal
      ? typedApplyReceipts.filter((receipt) =>
          artifactKey(receipt.proposal) === artifactKey(outcome.proposal!),
        )
      : [];
    rawCandidates.push({
      id: `refiner_outcome:${outcome.id}`,
      artifact: outcome,
      kind: "refiner_outcome",
      sourceRef: linkedObservations[0]?.runRef ?? trigger.runRef,
      payload: {
        outcome,
        trigger,
        observations: linkedObservations,
        turnContexts: await uniqueTurnContexts(linkedObservations, contextForObservation),
        applyReceipts: linkedApplyReceipts,
      },
    });
  }
  for (const observation of typedObservations) {
    if (representedObservationKeys.has(artifactKey(observation))) continue;
    rawCandidates.push({
      id: `observation:${observation.id}`,
      artifact: observation,
      kind: "observation",
      sourceRef: observation.runRef,
      payload: {
        observation,
        turnContext: await contextForObservation(observation),
      },
    });
  }
  const candidates: Candidate[] = [];
  const watermarkedArtifacts: Candidate["artifact"][] = [];
  let examined = 0;
  let estimatedTokens = 0;

  for (const candidate of rawCandidates
    .slice()
    .sort((left, right) =>
      left.artifact.createdAt.localeCompare(right.artifact.createdAt) ||
      left.id.localeCompare(right.id),
    )) {
    if (performance.now() - startedAt >= request.limits.maxDurationMs) {
      excludedEvidence.push({
        evidence: artifactRef(candidate.artifact),
        sourcePolicy: null,
        reason: "budget",
      });
      continue;
    }
    if (
      previousWatermark &&
      candidate.artifact.createdAt <= previousWatermark.throughCreatedAt
    ) {
      excludedEvidence.push({
        evidence: artifactRef(candidate.artifact),
        sourcePolicy: null,
        reason: "before_watermark",
      });
      continue;
    }
    if (examined >= request.limits.maxEvidence) {
      excludedEvidence.push({
        evidence: artifactRef(candidate.artifact),
        sourcePolicy: null,
        reason: "budget",
      });
      continue;
    }
    examined += 1;
    const candidateTokens = Math.ceil(JSON.stringify(candidate.payload).length / 4);
    if (estimatedTokens + candidateTokens > request.limits.maxTokens) {
      excludedEvidence.push({
        evidence: artifactRef(candidate.artifact),
        sourcePolicy: null,
        reason: "budget",
      });
      continue;
    }
    estimatedTokens += candidateTokens;
    watermarkedArtifacts.push(candidate.artifact);
    const policy = policyBySource.get(candidate.sourceRef);
    if (!policy || policy.state !== "authorized") {
      excludedEvidence.push({
        evidence: artifactRef(candidate.artifact),
        sourcePolicy: policy ? sourcePolicyRef(policy) : null,
        reason: policy && policy.state !== "authorized" ? policy.state : "unverified",
      });
      continue;
    }
    candidates.push(candidate);
  }

  let modelDecision: HarnessEvaluationReviewModelDecision = {
    schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
    decision: "no_action",
    reason: "No authorized unresolved evidence qualified for model review.",
    ignoredEvidence: [],
  };
  let modelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const navigation = { selectedIds: null as Set<string> | null };
  if (candidates.length > 0 && request.limits.maxEstimatedCostUsd === 0) {
    for (const candidate of candidates) {
      excludedEvidence.push({
        evidence: artifactRef(candidate.artifact),
        sourcePolicy: sourcePolicyRef(policyBySource.get(candidate.sourceRef)!),
        reason: "budget",
      });
    }
    modelDecision = {
      schemaVersion: "openpond.harnessEvaluationReviewModelDecision.v1",
      decision: "no_action",
      reason: "Continuous review is disabled by a zero model-cost ceiling.",
      ignoredEvidence: candidates.map((candidate) => ({
        id: candidate.id,
        reason: "The configured model-cost ceiling is zero.",
      })),
    };
  } else if (candidates.length > 0) {
    if (!input.stream) {
      throw new Error("Harness continuous review requires a model stream.");
    }
    modelDecision = await authorHarnessEvaluationReviewWithModel({
      evidence: candidates.map((candidate) => ({
        id: candidate.id,
        evidence: artifactRef(candidate.artifact),
        kind: candidate.kind,
        sourceRef: candidate.sourceRef,
        occurredAt: candidate.artifact.createdAt,
        payload: candidate.payload,
      })),
      harnessRelease: artifactRef(selectedRelease.harnessRelease),
      previousReviews: (reviews as HarnessEvaluationReviewReceipt[]).slice(0, 20),
      stream: async function* (streamInput) {
        let invocationUsage: typeof modelUsage | null = null;
        for await (const delta of input.stream!(streamInput)) {
          if (delta.usage) invocationUsage = delta.usage;
          yield delta;
        }
        if (invocationUsage) {
          modelUsage = {
            promptTokens: modelUsage.promptTokens + invocationUsage.promptTokens,
            completionTokens: modelUsage.completionTokens + invocationUsage.completionTokens,
            totalTokens: modelUsage.totalTokens + invocationUsage.totalTokens,
          };
        }
      },
      signal: input.signal ?? new AbortController().signal,
      timeoutMs: request.limits.maxDurationMs,
      onNavigation: (decision) => {
        navigation.selectedIds = new Set(decision.selectedEvidenceIds);
      },
    });
  }
  const deferredCandidates = navigation.selectedIds
    ? candidates.filter((candidate) => !navigation.selectedIds!.has(candidate.id))
    : [];
  for (const candidate of deferredCandidates) {
    excludedEvidence.push({
      evidence: artifactRef(candidate.artifact),
      sourcePolicy: sourcePolicyRef(policyBySource.get(candidate.sourceRef)!),
      reason: "budget",
    });
  }
  const selectedCandidates = modelDecision.decision === "review"
    ? modelDecision.selectedEvidenceIds.map((id) => {
        const candidate = candidates.find((item) => item.id === id);
        if (!candidate) throw new Error(`Review selected unavailable evidence ${id}.`);
        return candidate;
      })
    : [];
  const classification = modelDecision.decision === "review"
    ? modelDecision.classification
    : "no_action";
  const selectedEvidence = selectedCandidates.map((candidate) =>
    evidenceRef(candidate, policyBySource.get(candidate.sourceRef)!),
  );
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const deferredArtifactKeys = new Set(
    deferredCandidates.map((candidate) => artifactKey(candidate.artifact)),
  );
  const examinedArtifacts = watermarkedArtifacts.filter(
    (artifact) => !deferredArtifactKeys.has(artifactKey(artifact)),
  );
  const examinedCreatedAt = examinedArtifacts
    .map((artifact) => artifact.createdAt)
    .sort()
    .at(-1);
  const throughCreatedAt = examinedCreatedAt
    ? maxTimestamp(previousWatermark?.throughCreatedAt, examinedCreatedAt)
    : maxTimestamp(previousWatermark?.throughCreatedAt, createdAt);
  const cursor = contentHash({
    previousCursor: previousWatermark?.cursor ?? null,
    throughCreatedAt,
    examined: examinedArtifacts.map(artifactRef),
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
    claim: modelDecision.decision === "review" ? {
      fingerprint: contentHash({
        family: modelDecision.recurrenceFamily,
        evidence: selectedEvidence.map((item) => item.occurrenceKey),
      }),
      recurrenceFamily: modelDecision.recurrenceFamily,
      statement: modelDecision.statement,
      independentOccurrences: new Set(selectedCandidates.map((item) => item.sourceRef)).size,
      unresolvedOccurrences: new Set(selectedCandidates.map((item) => item.sourceRef)).size,
    } : null,
    classification,
    triage: modelDecision.decision === "review" ? [{
      layer: modelDecision.triageLayer,
      status: "unresolved",
      reason: modelDecision.reason,
      evidenceRefs: selectedEvidence.map((item) => item.evidence),
    }] : [],
    reason: modelDecision.reason,
    nextAuthority: nextAuthority(classification),
    maxEstimatedCostUsd: request.limits.maxEstimatedCostUsd,
    tasksetProposal: null,
    evaluation: null,
    trainingQualification: null,
    policyVersion: "public-model-driven-harness-review-v1",
    createdAt,
    metadata: {
      examinedEvidence: examined,
      fullyReviewedEvidence: navigation.selectedIds?.size ?? candidates.length,
      estimatedTokens,
      elapsedMs: performance.now() - startedAt,
      explicitInvocation: true,
      modelDecision: modelDecision.decision,
      modelConfidence:
        modelDecision.decision === "review" ? modelDecision.confidence : null,
      counterevidence:
        modelDecision.decision === "review" ? modelDecision.counterevidence : null,
      expectedOutcome:
        modelDecision.decision === "review" ? modelDecision.expectedOutcome : null,
      ignoredEvidence: modelDecision.ignoredEvidence,
      modelUsage,
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

function evidenceRef(
  candidate: Candidate,
  policy: ReviewRequest["sourcePolicies"][number],
): HarnessReviewEvidenceRef {
  return {
    evidence: artifactRef(candidate.artifact),
    kind: candidate.kind,
    sourceRef: candidate.sourceRef,
    sourcePolicy: sourcePolicyRef(policy),
    occurrenceKey: contentHash({
      evidence: artifactRef(candidate.artifact),
      sourceRef: candidate.sourceRef,
    }),
    occurredAt: candidate.artifact.createdAt,
  };
}

function nextAuthority(classification: ReviewClassification): HarnessEvaluationReviewReceipt["nextAuthority"] {
  if (classification === "runtime") return "runtime_service";
  if (classification === "product") return "product_team";
  if (classification === "taskset") return "human_review";
  if (classification === "harness_maintenance") return "human_review";
  if (classification === "model_improvement") return "training_system";
  return "none";
}

function maxTimestamp(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1)!;
}

function boundedReviewEvent(event: RuntimeEvent): Record<string, unknown> {
  const data = asRecord(event.data);
  const result = asRecord(data.result);
  return {
    id: event.id,
    name: event.name,
    action: event.action ?? (typeof data.tool === "string" ? data.tool : null),
    status: event.status ?? null,
    error: boundedReviewText(event.error ?? "", 750),
    output: boundedReviewText(
      typeof result.output === "string" ? result.output : event.output ?? "",
      750,
    ),
    stderr: boundedReviewText(
      typeof result.stderr === "string" ? result.stderr : "",
      750,
    ),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    timedOut: result.timedOut === true,
  };
}

async function uniqueTurnContexts(
  observations: readonly ImprovementObservation[],
  load: (observation: ImprovementObservation) => Promise<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const byTurn = new Map<string, ImprovementObservation>();
  for (const observation of observations) {
    byTurn.set(`${observation.runRef}:${observation.turnId}`, observation);
  }
  return Promise.all([...byTurn.values()].map(load));
}

function boundedReviewText(value: string, maxLength: number): string | null {
  if (!value) return null;
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[redacted]",
    );
  if (redacted.length <= maxLength) return redacted;
  const marker = "\n[... middle omitted ...]\n";
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${redacted.slice(0, headLength)}${marker}${redacted.slice(-tailLength)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
