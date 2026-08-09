import {
  type ChatModelRef,
  type CodexReasoningEffort,
  type HarnessEvaluationReviewReceipt,
  type ImprovementObservation,
  type ImprovementRouteDecision,
  type RefinementTriggerDecision,
  type TaskCreationSnapshot,
  type Taskset,
  type TrainingSourceRef,
} from "@openpond/contracts";
import {
  contentHash,
  createHarnessEvaluationReviewReceipt,
  type EvaluationResult,
} from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import type { createTaskCreatorService } from "./task-creator.js";

type TaskCreator = ReturnType<typeof createTaskCreatorService>;

const HARNESS_REVIEW_TASKSET_STRATEGY = {
  buildIntent: "verifiable_reward",
  methodHint: "grpo",
} as const;

export async function startHarnessReviewTasksetAuthoring(input: {
  store: SqliteStore;
  taskCreator: Pick<TaskCreator, "addSessionSource">;
  startCreation: (input: Parameters<TaskCreator["start"]>[0]) => Promise<TaskCreationSnapshot>;
  profileId: string;
  workspaceId: string;
  reviewRef: { id: string; contentHash: string };
  analysisModel?: ChatModelRef | null;
  analysisReasoningEffort?: CodexReasoningEffort | null;
}): Promise<TaskCreationSnapshot> {
  const review = await requireTasksetReview(input.store, input.workspaceId, input.reviewRef);
  const candidateId = `harness-review-${contentHash({
    review: review.contentHash,
    strategy: HARNESS_REVIEW_TASKSET_STRATEGY,
  }).slice(0, 24)}`;
  const existing = (await input.store.listTaskCreationSnapshots(input.profileId))
    .find((snapshot) => snapshot.request.candidateId === candidateId);
  if (existing) return existing;

  const [routes, triggers, observations] = await Promise.all([
    input.store.listHarnessImprovementArtifacts(input.workspaceId, "route_decision", 1_000),
    input.store.listHarnessImprovementArtifacts(input.workspaceId, "trigger_decision", 1_000),
    input.store.listHarnessImprovementArtifacts(input.workspaceId, "observation", 1_000),
  ]);
  const routeByRef = new Map(
    (routes as ImprovementRouteDecision[]).map((route) => [artifactKey(route), route]),
  );
  const triggerByRef = new Map(
    (triggers as RefinementTriggerDecision[]).map((trigger) => [artifactKey(trigger), trigger]),
  );
  const observationByRef = new Map(
    (observations as ImprovementObservation[]).map((observation) => [artifactKey(observation), observation]),
  );
  const sourceGroups = new Map<string, {
    turnIds: Set<string>;
    evidenceRefs: Array<{ id: string; contentHash: string }>;
    sourcePolicies: HarnessEvaluationReviewReceipt["selectedEvidence"][number]["sourcePolicy"][];
  }>();
  for (const selected of review.selectedEvidence) {
    if (selected.kind !== "route_decision") continue;
    const route = routeByRef.get(artifactKey(selected.evidence));
    const trigger = route ? triggerByRef.get(artifactKey(route.trigger)) : null;
    if (!route || !trigger) {
      throw new Error(`Harness review evidence ${selected.evidence.id} cannot be reconstructed.`);
    }
    const matching = trigger.observations
      .map((reference) => observationByRef.get(artifactKey(reference)) ?? null)
      .filter((observation): observation is ImprovementObservation =>
        observation?.runRef === selected.sourceRef,
      );
    if (!matching.length) {
      throw new Error(`Harness review source ${selected.sourceRef} has no exact observation evidence.`);
    }
    const group = sourceGroups.get(selected.sourceRef) ?? {
      turnIds: new Set<string>(),
      evidenceRefs: [],
      sourcePolicies: [],
    };
    for (const observation of matching) group.turnIds.add(observation.turnId);
    group.evidenceRefs.push(selected.evidence);
    group.sourcePolicies.push(selected.sourcePolicy);
    sourceGroups.set(selected.sourceRef, group);
  }
  if (!sourceGroups.size) {
    throw new Error("Harness Taskset review has no reconstructable source runs.");
  }

  const sources: TrainingSourceRef[] = [];
  for (const [sessionId, group] of [...sourceGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const source = await input.taskCreator.addSessionSource({
      profileId: input.profileId,
      sessionId,
      turnIds: [...group.turnIds].sort(),
      consentScope: "selected_turns",
    });
    const priorReviews = Array.isArray(source.metadata.harnessEvaluationReviews)
      ? source.metadata.harnessEvaluationReviews
      : [];
    const enriched = {
      ...source,
      metadata: {
        ...source.metadata,
        harnessEvaluationReviews: uniqueObjects([
          ...priorReviews,
          {
            id: review.id,
            contentHash: review.contentHash,
            workspaceId: review.workspaceRef,
            harnessRelease: review.harnessRelease,
            claimFingerprint: review.claim?.fingerprint ?? null,
            evidenceRefs: group.evidenceRefs,
            sourcePolicies: group.sourcePolicies,
          },
        ]),
      },
    };
    sources.push(await input.store.upsertTrainingSource(enriched));
  }

  return input.startCreation({
    profileId: input.profileId,
    sourceIds: sources.map((source) => source.id),
    surface: "task_candidate",
    mode: "customize",
    entryMode: "automated",
    resourceIntent: "workproduct",
    buildIntent: HARNESS_REVIEW_TASKSET_STRATEGY.buildIntent,
    buildSpecification: null,
    objective: review.claim?.statement ?? review.reason,
    methodHint: HARNESS_REVIEW_TASKSET_STRATEGY.methodHint,
    preferredBaseModelId: null,
    preferredBaseModel: null,
    candidateId,
    analysisModel: input.analysisModel ?? null,
    analysisReasoningEffort: input.analysisReasoningEffort ?? null,
    createImproveRunId: null,
    targetIntent: {
      kind: "model",
      id: null,
      displayName: null,
      operation: "create",
    },
  });
}

export function harnessReviewLineageFromSources(sources: TrainingSourceRef[]): {
  review: { id: string; contentHash: string; workspaceId: string; harnessRelease: unknown; claimFingerprint: string | null };
  evidenceRefs: unknown[];
  sourcePolicies: unknown[];
} | null {
  const entries = sources.flatMap((source) =>
    Array.isArray(source.metadata.harnessEvaluationReviews)
      ? source.metadata.harnessEvaluationReviews.filter(isRecord)
      : [],
  );
  if (!entries.length) return null;
  const reviewKey = `${String(entries[0]!.id)}:${String(entries[0]!.contentHash)}`;
  const matching = entries.filter((entry) =>
    `${String(entry.id)}:${String(entry.contentHash)}` === reviewKey,
  );
  if (matching.length !== sources.length) {
    return null;
  }
  const first = matching[0]!;
  return {
    review: {
      id: String(first.id),
      contentHash: String(first.contentHash),
      workspaceId: String(first.workspaceId),
      harnessRelease: first.harnessRelease,
      claimFingerprint: typeof first.claimFingerprint === "string" ? first.claimFingerprint : null,
    },
    evidenceRefs: uniqueObjects(matching.flatMap((entry) => Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [])),
    sourcePolicies: uniqueObjects(matching.flatMap((entry) => Array.isArray(entry.sourcePolicies) ? entry.sourcePolicies : [])),
  };
}

export async function linkHarnessReviewTaskset(input: {
  store: SqliteStore;
  taskset: Taskset;
  evaluationResult?: EvaluationResult | null;
  now?: () => string;
}): Promise<HarnessEvaluationReviewReceipt | null> {
  const lineage = input.taskset.metadata.harnessEvaluationLineage;
  if (!isRecord(lineage) || !isRecord(lineage.review)) return null;
  const workspaceId = String(lineage.review.workspaceId ?? "");
  const originRef = {
    id: String(lineage.review.id ?? ""),
    contentHash: String(lineage.review.contentHash ?? ""),
  };
  if (!workspaceId || !originRef.id || !originRef.contentHash) {
    throw new Error("Taskset Harness Evaluation lineage is incomplete.");
  }
  const reviews = await input.store.listHarnessImprovementArtifacts(
    workspaceId,
    "evaluation_review",
    1_000,
  ) as HarnessEvaluationReviewReceipt[];
  const origin = reviews.find((review) => artifactKey(review) === artifactKey(originRef));
  if (!origin) throw new Error("Originating Harness Evaluation review was not found.");
  const evaluationRef = input.evaluationResult
    ? { id: input.evaluationResult.id, contentHash: input.evaluationResult.contentHash }
    : null;
  const tasksetRef = { id: input.taskset.id, contentHash: input.taskset.contentHash };
  const linkKey = contentHash({ originRef, tasksetRef, evaluationRef });
  const existing = reviews.find((review) => review.metadata.downstreamLinkKey === linkKey);
  if (existing) return existing;
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const receipt = createHarnessEvaluationReviewReceipt({
    schemaVersion: "openpond.harnessEvaluationReviewReceipt.v1",
    id: `evaluation-review-link-${linkKey.slice(0, 24)}`,
    ownerScope: origin.ownerScope,
    workspaceRef: origin.workspaceRef,
    harnessRelease: origin.harnessRelease,
    previousWatermark: origin.nextWatermark,
    nextWatermark: {
      cursor: contentHash({ cursor: origin.nextWatermark.cursor, tasksetRef, evaluationRef }),
      throughCreatedAt: createdAt,
    },
    selectedEvidence: origin.selectedEvidence,
    excludedEvidence: origin.excludedEvidence,
    claim: origin.claim,
    classification: "taskset",
    triage: origin.triage,
    reason: evaluationRef
      ? "The approved Taskset completed a real baseline Evaluation."
      : "The approved Harness review materialized one immutable Taskset.",
    nextAuthority: "human_review",
    maxEstimatedCostUsd: origin.maxEstimatedCostUsd,
    tasksetProposal: tasksetRef,
    evaluation: evaluationRef,
    trainingQualification: null,
    policyVersion: origin.policyVersion,
    createdAt,
    metadata: {
      originReview: originRef,
      downstreamLinkKey: linkKey,
      tasksetRevision: input.taskset.revision,
    },
  });
  await input.store.saveHarnessImprovementArtifact(workspaceId, "evaluation_review", receipt);
  return receipt;
}

async function requireTasksetReview(
  store: SqliteStore,
  workspaceId: string,
  expected: { id: string; contentHash: string },
): Promise<HarnessEvaluationReviewReceipt> {
  const workspace = await store.getHarnessWorkspace(workspaceId);
  if (!workspace) throw new Error(`Harness workspace ${workspaceId} was not found.`);
  const review = (await store.listHarnessImprovementArtifacts(workspaceId, "evaluation_review", 1_000))
    .find((candidate) => candidate.id === expected.id && candidate.contentHash === expected.contentHash);
  if (!review || review.schemaVersion !== "openpond.harnessEvaluationReviewReceipt.v1") {
    throw new Error("Harness Evaluation review was not found.");
  }
  const typed = review as HarnessEvaluationReviewReceipt;
  if (typed.classification !== "taskset" || typed.nextAuthority !== "human_review") {
    throw new Error("Only a human-review Taskset recommendation can enter Taskset authoring.");
  }
  if (typed.tasksetProposal) {
    throw new Error("Harness Evaluation review already has a materialized Taskset link.");
  }
  if (typed.ownerScope.kind !== workspace.ownerScope.kind || typed.ownerScope.id !== workspace.ownerScope.id) {
    throw new Error("Harness Evaluation review owner scope does not match its workspace.");
  }
  return typed;
}

function artifactKey(value: { id: string; contentHash: string }): string {
  return `${value.id}:${value.contentHash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueObjects(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
