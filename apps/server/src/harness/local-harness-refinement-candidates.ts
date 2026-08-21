import type {
  HarnessEvaluationReviewReceipt,
  HarnessRefinementCandidate,
  HarnessRefinementCandidateLifecycleReceipt,
  HarnessReviewEvidenceRef,
  HarnessWorkspace,
} from "@openpond/contracts";
import {
  contentHash,
  createHarnessRefinementCandidate,
  createHarnessRefinementCandidateLifecycleReceipt,
} from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";

const CANDIDATE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;

type SourcePolicy = HarnessEvaluationReviewReceipt["selectedEvidence"][number]["sourcePolicy"];

export type LocalHarnessCandidateReconciliation = {
  activeCandidate: HarnessRefinementCandidate | null;
  candidates: HarnessRefinementCandidate[];
  lifecycleReceipts: HarnessRefinementCandidateLifecycleReceipt[];
};

export async function reconcileLocalHarnessRefinementCandidates(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  review: HarnessEvaluationReviewReceipt;
  sourcePolicies: Map<string, SourcePolicy>;
  now: string;
  upsertReviewClaim?: boolean;
}): Promise<LocalHarnessCandidateReconciliation> {
  const lifecycleReceipts: HarnessRefinementCandidateLifecycleReceipt[] = [];
  const current = await input.store.listHarnessRefinementCandidates(input.workspace.id);
  const claimFingerprint = input.upsertReviewClaim !== false
    && input.review.classification === "harness_maintenance"
    ? input.review.claim?.fingerprint ?? null
    : null;
  for (const candidate of current) {
    if (candidate.fingerprint === claimFingerprint) continue;
    const transition = reauthorizeOrExpireCandidate({ ...input, candidate });
    if (!transition) continue;
    await input.store.saveHarnessRefinementCandidateTransition({
      workspaceId: input.workspace.id,
      ...transition,
    });
    lifecycleReceipts.push(transition.receipt);
  }

  let activeCandidate: HarnessRefinementCandidate | null = null;
  if (
    input.upsertReviewClaim !== false
    && input.review.classification === "harness_maintenance"
    && input.review.claim
  ) {
    const existing = await input.store.getHarnessRefinementCandidateByFingerprint(
      input.workspace.id,
      input.review.claim.fingerprint,
    );
    const transition = upsertCandidateFromReview({ ...input, candidate: existing });
    if (transition) {
      await input.store.saveHarnessRefinementCandidateTransition({
        workspaceId: input.workspace.id,
        ...transition,
      });
      lifecycleReceipts.push(transition.receipt);
      activeCandidate = transition.candidate;
    } else {
      activeCandidate = existing;
    }
  }

  const candidates = await input.store.listHarnessRefinementCandidates(input.workspace.id);
  if (input.upsertReviewClaim === false) {
    activeCandidate = candidates.find((candidate) =>
      candidate.status === "confirmed"
      && candidate.sourceReviews.some((review) =>
        review.id === input.review.id && review.contentHash === input.review.contentHash,
      ),
    ) ?? null;
  }
  return {
    activeCandidate,
    candidates,
    lifecycleReceipts,
  };
}

export async function recordAppliedLocalHarnessRefinementCandidate(input: {
  store: SqliteStore;
  candidate: HarnessRefinementCandidate;
  review: HarnessEvaluationReviewReceipt;
  relatedHarnessRelease: { id: string; contentHash: string } | null;
  reason: string;
  now: string;
}): Promise<HarnessRefinementCandidate> {
  if (!["unresolved", "confirmed"].includes(input.candidate.status)) {
    return input.candidate;
  }
  const candidate = createHarnessRefinementCandidate({
    ...withoutHash(input.candidate),
    sourceReviews: uniqueRefs([
      ...input.candidate.sourceReviews,
      artifactRef(input.review),
    ]),
    relatedHarnessReleases: uniqueRefs([
      ...input.candidate.relatedHarnessReleases,
      ...(input.relatedHarnessRelease ? [input.relatedHarnessRelease] : []),
    ]),
    lastReviewedAt: input.now,
    updatedAt: input.now,
    resolution: null,
  });
  const applied = transition({
    before: input.candidate,
    candidate,
    review: input.review,
    decision: "merged",
    addedEvidence: [],
    removedEvidence: [],
    reason: input.reason,
    now: input.now,
  });
  await input.store.saveHarnessRefinementCandidateTransition({
    workspaceId: input.candidate.workspaceRef,
    ...applied,
  });
  return candidate;
}

export async function resolveLocalHarnessRefinementCandidateFromLaterSuccess(input: {
  store: SqliteStore;
  candidate: HarnessRefinementCandidate;
  review: HarnessEvaluationReviewReceipt;
  evidence: HarnessReviewEvidenceRef[];
  reason: string;
  now: string;
}): Promise<HarnessRefinementCandidate> {
  if (input.candidate.status !== "confirmed") {
    throw new Error("Later-success resolution requires a confirmed candidate.");
  }
  const currentRelease = input.review.harnessRelease;
  const appliedRelease = input.candidate.relatedHarnessReleases.at(-1);
  if (
    input.candidate.relatedHarnessReleases.length < 2
    || !appliedRelease
    || appliedRelease.id !== currentRelease.id
    || appliedRelease.contentHash !== currentRelease.contentHash
  ) {
    throw new Error("Later-success evidence is not bound to the candidate's applied Harness release.");
  }
  const priorSources = new Set(input.candidate.occurrences.map((item) => item.sourceRef));
  const independentEvidence = input.evidence.filter((item) => !priorSources.has(item.sourceRef));
  if (independentEvidence.length === 0) {
    throw new Error("Later-success resolution requires evidence from an independent work source.");
  }
  const candidate = createHarnessRefinementCandidate({
    ...withoutHash(input.candidate),
    status: "resolved",
    sourceReviews: uniqueRefs([
      ...input.candidate.sourceReviews,
      artifactRef(input.review),
    ]),
    lastReviewedAt: input.now,
    updatedAt: input.now,
    resolution: {
      kind: "later_success",
      reason: input.reason,
      evidenceRefs: uniqueRefs(independentEvidence.map((item) => item.evidence)),
      resolvedAt: input.now,
    },
  });
  const resolved = transition({
    before: input.candidate,
    candidate,
    review: input.review,
    decision: "resolved",
    addedEvidence: independentEvidence,
    removedEvidence: [],
    reason: input.reason,
    now: input.now,
  });
  await input.store.saveHarnessRefinementCandidateTransition({
    workspaceId: input.candidate.workspaceRef,
    ...resolved,
  });
  return candidate;
}

function reauthorizeOrExpireCandidate(input: {
  workspace: HarnessWorkspace;
  review: HarnessEvaluationReviewReceipt;
  sourcePolicies: Map<string, SourcePolicy>;
  candidate: HarnessRefinementCandidate;
  now: string;
}): CandidateTransition | null {
  if (!["unresolved", "confirmed"].includes(input.candidate.status)) return null;
  const removed: HarnessReviewEvidenceRef[] = [];
  const occurrences = reauthorizedEvidence(
    input.candidate.occurrences,
    input.sourcePolicies,
    removed,
  );
  const counterevidence = reauthorizedEvidence(
    input.candidate.counterevidence,
    input.sourcePolicies,
    removed,
  );
  const sourceReviews = uniqueRefs([
    ...input.candidate.sourceReviews,
    artifactRef(input.review),
  ]);
  const expired = Date.parse(input.candidate.expiresAt) <= Date.parse(input.now);
  const rejected = occurrences.length === 0;
  const status = rejected ? "rejected" as const
    : expired ? "expired" as const
      : removed.length > 0
        ? "unresolved" as const
        : input.candidate.status;
  const decision = rejected ? "rejected" as const
    : expired ? "expired" as const
      : "merged" as const;
  const changed = removed.length > 0
    || input.candidate.lastReviewedAt !== input.now
    || input.candidate.sourceReviews.length !== sourceReviews.length;
  if (!changed && !expired) return null;
  const reason = rejected
    ? "All supporting occurrences were revoked, deleted, expired, or unavailable at review time."
    : expired
      ? "The bounded candidate lifetime elapsed without sufficient confirming evidence."
      : "Candidate evidence was reauthorized against the current source policy set.";
  const candidate = createHarnessRefinementCandidate({
    ...withoutHash(input.candidate),
    status,
    occurrences,
    counterevidence,
    sourceReviews,
    lastReviewedAt: input.now,
    updatedAt: input.now,
    expiresAt: expired ? input.now : input.candidate.expiresAt,
    resolution: rejected || expired ? {
      kind: rejected ? "source_revoked" : "expired",
      reason,
      evidenceRefs: removed.map((item) => item.evidence),
      resolvedAt: input.now,
    } : null,
  });
  return transition({
    before: input.candidate,
    candidate,
    review: input.review,
    decision,
    addedEvidence: [],
    removedEvidence: removed.map((item) => item.evidence),
    reason,
    now: input.now,
  });
}

function upsertCandidateFromReview(input: {
  workspace: HarnessWorkspace;
  review: HarnessEvaluationReviewReceipt;
  candidate: HarnessRefinementCandidate | null;
  sourcePolicies: Map<string, SourcePolicy>;
  now: string;
}): CandidateTransition | null {
  const claim = input.review.claim!;
  const before = input.candidate;
  const removedEvidence: HarnessReviewEvidenceRef[] = [];
  const authorizedOccurrences = before
    ? reauthorizedEvidence(before.occurrences, input.sourcePolicies, removedEvidence)
    : [];
  const authorizedCounterevidence = before
    ? reauthorizedEvidence(before.counterevidence, input.sourcePolicies, removedEvidence)
    : [];
  const existingOccurrenceKeys = new Set(
    before && ["unresolved", "confirmed"].includes(before.status)
      ? authorizedOccurrences.map((item) => item.occurrenceKey)
      : [],
  );
  const addedEvidence = input.review.selectedEvidence.filter(
    (item) => !existingOccurrenceKeys.has(item.occurrenceKey),
  );
  if (
    before
    && addedEvidence.length === 0
    && removedEvidence.length === 0
    && ["unresolved", "confirmed"].includes(before.status)
  ) {
    return null;
  }
  const occurrences = uniqueEvidence([
    ...authorizedOccurrences,
    ...input.review.selectedEvidence,
  ]);
  const status = claim.candidateDisposition === "confirm"
    ? "confirmed" as const
    : "unresolved" as const;
  const firstSeenAt = occurrences.map((item) => item.occurredAt).sort()[0]!;
  const lastSeenAt = occurrences.map((item) => item.occurredAt).sort().at(-1)!;
  const candidate = createHarnessRefinementCandidate({
    schemaVersion: "openpond.harnessRefinementCandidate.v1",
    id: before?.id ?? `refinement-candidate-${claim.fingerprint.slice(0, 24)}`,
    ownerScope: input.workspace.ownerScope,
    workspaceRef: input.workspace.id,
    fingerprint: claim.fingerprint,
    recurrenceFamily: claim.recurrenceFamily,
    statement: claim.statement,
    status,
    occurrences,
    counterevidence: authorizedCounterevidence,
    sourceReviews: uniqueRefs([
      ...(before?.sourceReviews ?? []),
      artifactRef(input.review),
    ]),
    relatedHarnessReleases: uniqueRefs([
      ...(before?.relatedHarnessReleases ?? []),
      input.review.harnessRelease,
    ]),
    firstSeenAt,
    lastSeenAt,
    lastReviewedAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + CANDIDATE_LIFETIME_MS).toISOString(),
    resolution: null,
    createdAt: before?.createdAt ?? input.now,
    updatedAt: input.now,
  });
  const decision = !before ? "created" as const
    : ["resolved", "rejected", "expired"].includes(before.status)
      ? "reopened" as const
      : "merged" as const;
  return transition({
    before,
    candidate,
    review: input.review,
    decision,
    addedEvidence,
    removedEvidence: removedEvidence.map((item) => item.evidence),
    reason: decision === "created"
      ? "Created a bounded candidate from an authorized cross-Work Harness claim."
      : decision === "reopened"
        ? "New authorized evidence reopened the prior candidate."
        : "Merged new authorized evidence into the existing candidate.",
    now: input.now,
  });
}

type CandidateTransition = {
  candidate: HarnessRefinementCandidate;
  receipt: HarnessRefinementCandidateLifecycleReceipt;
};

function transition(input: {
  before: HarnessRefinementCandidate | null;
  candidate: HarnessRefinementCandidate;
  review: HarnessEvaluationReviewReceipt;
  decision: HarnessRefinementCandidateLifecycleReceipt["decision"];
  addedEvidence: HarnessReviewEvidenceRef[];
  removedEvidence: Array<{ id: string; contentHash: string }>;
  reason: string;
  now: string;
}): CandidateTransition {
  const receipt = createHarnessRefinementCandidateLifecycleReceipt({
    schemaVersion: "openpond.harnessRefinementCandidateLifecycleReceipt.v1",
    id: `candidate-lifecycle-${contentHash({
      candidate: artifactRef(input.candidate),
      review: artifactRef(input.review),
      decision: input.decision,
    }).slice(0, 24)}`,
    candidateId: input.candidate.id,
    decision: input.decision,
    beforeCandidate: input.before ? artifactRef(input.before) : null,
    afterCandidate: artifactRef(input.candidate),
    review: artifactRef(input.review),
    addedEvidence: input.addedEvidence,
    removedEvidence: input.removedEvidence,
    reason: input.reason,
    createdAt: input.now,
  });
  return { candidate: input.candidate, receipt };
}

function reauthorizedEvidence(
  evidence: HarnessReviewEvidenceRef[],
  policies: Map<string, SourcePolicy>,
  removed: HarnessReviewEvidenceRef[],
): HarnessReviewEvidenceRef[] {
  return evidence.flatMap((item) => {
    const policy = policies.get(item.sourceRef);
    if (!policy || policy.state !== "authorized") {
      removed.push(item);
      return [];
    }
    return [{ ...item, sourcePolicy: policy }];
  });
}

function uniqueEvidence(evidence: HarnessReviewEvidenceRef[]): HarnessReviewEvidenceRef[] {
  return [...new Map(evidence.map((item) => [item.occurrenceKey, item])).values()]
    .sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt)
      || left.occurrenceKey.localeCompare(right.occurrenceKey),
    );
}

function uniqueRefs<T extends { id: string; contentHash: string }>(refs: T[]): T[] {
  return [...new Map(refs.map((item) => [`${item.id}:${item.contentHash}`, item])).values()];
}

function artifactRef(artifact: { id: string; contentHash: string }) {
  return { id: artifact.id, contentHash: artifact.contentHash };
}

function withoutHash(candidate: HarnessRefinementCandidate) {
  const { contentHash: _contentHash, ...content } = candidate;
  return content;
}
