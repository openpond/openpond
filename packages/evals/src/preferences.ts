import { z } from "zod";

import {
  ImmutableArtifactRefSchema,
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  contentHash,
} from "@openpond/harness";

import {
  ArtifactManifestContentSchema,
  ArtifactManifestSchema,
  RewardComponentReceiptSchema,
  type ArtifactManifest,
  type FailureOwner,
  type RewardComponentReceipt,
} from "./execution-contracts.js";
import {
  AttemptReceiptSchema,
  RunManifestSchema,
  assertComparableRunManifests,
  verifyAttemptReceipt,
  type AttemptReceipt,
  type HarnessCompatibilityReceipt,
  type RunManifest,
} from "./runs.js";
import {
  TasksetReleaseContentSchema,
  TasksetReleaseSchema,
  type TasksetRelease,
} from "./tasksets.js";

export const PreferenceComparisonPurposeSchema = z.enum([
  "calibration",
  "training_reward",
  "validation",
  "frozen_eval",
]);
export const PreferenceReviewerKindSchema = z.enum([
  "human",
  "model",
  "deterministic",
]);
export const PreferenceRendererSchema = z.enum([
  "markdown",
  "text",
  "code",
  "json",
  "image",
]);

const PreferenceCriterionSchema = z.object({
  id: ReleaseIdSchema,
  label: z.string().trim().min(1).max(500),
  instruction: z.string().trim().min(1).max(10_000),
  weight: z.number().nonnegative().max(1_000),
}).strict();

const CandidatePresentationPartSchema = z.object({
  source: z.enum(["attempt_output", "artifact"]),
  path: z.string().trim().min(1).max(2_000),
  renderer: PreferenceRendererSchema,
}).strict();

const CandidatePresentationSpecSchema = z.object({
  showTaskPrompt: z.boolean(),
  randomizeCandidateOrder: z.boolean(),
  hideModelIdentity: z.boolean(),
  parts: z.array(CandidatePresentationPartSchema).min(1).max(20),
}).strict().superRefine((presentation, context) => {
  if (!presentation.parts.some((part) => part.renderer === "markdown" || part.renderer === "text")) {
    context.addIssue({
      code: "custom",
      path: ["parts"],
      message: "A preference presentation must expose text or Markdown content.",
    });
  }
});

const PreferenceAssignmentPolicySchema = z.object({
  strategy: z.literal("randomized_blinded_v1"),
  maxAssignmentsPerCandidate: z.number().int().positive().max(10_000),
}).strict();

const PreferenceAggregationPolicySchema = z.object({
  algorithm: z.literal("mean_pairwise_win_fraction_v1"),
  quorum: z.number().int().positive().max(100),
  rejectAllThreshold: z.number().min(0.5).max(1),
}).strict();

const PreferenceRewardProjectionSchema = z.object({
  algorithm: z.literal("pairwise_win_fraction_v1"),
  verifierId: ReleaseIdSchema,
  verifierVersion: z.string().trim().min(1).max(100),
  weight: z.number().positive().max(1_000),
}).strict();

const PreferenceCalibrationPolicySchema = z.object({
  minimumSamples: z.number().int().positive().max(100_000),
  minimumOrderAgreement: z.number().min(0).max(1),
  minimumTieAgreement: z.number().min(0).max(1),
  minimumOrderSwapAgreement: z.number().min(0).max(1),
}).strict();

export const PreferenceComparisonReleaseContentSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceComparisonRelease.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  tasksetRelease: ImmutableReleaseRefSchema,
  candidateCount: z.number().int().min(2).max(4),
  resultMode: z.literal("ordered_tie_groups"),
  allowTies: z.boolean(),
  allowRejectAll: z.boolean(),
  presentation: CandidatePresentationSpecSchema,
  rubricRef: ImmutableArtifactRefSchema,
  criteria: z.array(PreferenceCriterionSchema).max(20),
  assignment: PreferenceAssignmentPolicySchema,
  aggregation: PreferenceAggregationPolicySchema,
  rewardProjection: PreferenceRewardProjectionSchema,
  calibration: PreferenceCalibrationPolicySchema,
  metadata: MetadataSchema,
}).strict().superRefine((release, context) => {
  const criteria = release.criteria.map((criterion) => criterion.id);
  if (new Set(criteria).size !== criteria.length) {
    context.addIssue({ code: "custom", path: ["criteria"], message: "Preference criterion IDs must be unique." });
  }
});
export const PreferenceComparisonReleaseSchema = PreferenceComparisonReleaseContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

const PreferenceTaskReferenceSchema = z.object({
  id: ReleaseIdSchema,
  contentHash: ReleaseHashSchema,
}).strict();

const PreferenceComparisonLineageSchema = z.object({
  tasksetRelease: ImmutableReleaseRefSchema,
  harnessReleases: z.array(ImmutableReleaseRefSchema).min(1).max(4),
  runManifestRefs: z.array(ImmutableReleaseRefSchema).min(1).max(4),
  harnessCompatibilityReceiptRefs: z.array(ImmutableReleaseRefSchema).max(6),
  environmentRelease: ImmutableReleaseRefSchema,
  verifierSetRelease: ImmutableReleaseRefSchema,
  toolContractHash: ReleaseHashSchema,
  policyHash: ReleaseHashSchema,
}).strict();

const ComparisonCandidateSchema = z.object({
  attemptRef: ImmutableReleaseRefSchema,
  runManifestRef: ImmutableReleaseRefSchema,
  artifactManifestRef: ImmutableReleaseRefSchema,
  visibleArtifactIds: z.array(ReleaseIdSchema).min(1).max(100_000),
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.visibleArtifactIds).size !== candidate.visibleArtifactIds.length) {
    context.addIssue({
      code: "custom",
      path: ["visibleArtifactIds"],
      message: "Visible artifact IDs must be unique per candidate.",
    });
  }
});

const ComparisonAssignmentBaseSchema = z.object({
  schemaVersion: z.literal("openpond.comparisonAssignment.v1"),
  id: ReleaseIdSchema,
  comparisonRelease: ImmutableReleaseRefSchema,
  taskRef: PreferenceTaskReferenceSchema,
  lineage: PreferenceComparisonLineageSchema,
  candidates: z.array(ComparisonCandidateSchema).min(2).max(4),
  presentedCandidateOrder: z.array(ReleaseIdSchema).min(2).max(4),
  purpose: PreferenceComparisonPurposeSchema,
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict().superRefine((assignment, context) => {
  const candidateIds = assignment.candidates.map((candidate) => candidate.attemptRef.id);
  if (new Set(candidateIds).size !== candidateIds.length) {
    context.addIssue({ code: "custom", path: ["candidates"], message: "An assignment cannot contain the same attempt twice." });
  }
  if (
    new Set(assignment.presentedCandidateOrder).size !== assignment.presentedCandidateOrder.length
    || assignment.presentedCandidateOrder.length !== candidateIds.length
    || assignment.presentedCandidateOrder.some((id) => !candidateIds.includes(id))
  ) {
    context.addIssue({
      code: "custom",
      path: ["presentedCandidateOrder"],
      message: "Presented candidate order must contain every assignment candidate exactly once.",
    });
  }
});
export const ComparisonAssignmentContentSchema = ComparisonAssignmentBaseSchema;
export const ComparisonAssignmentSchema = ComparisonAssignmentBaseSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict()
  .superRefine((assignment, context) => {
    const candidateIds = assignment.candidates.map((candidate) => candidate.attemptRef.id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({ code: "custom", path: ["candidates"], message: "An assignment cannot contain the same attempt twice." });
    }
  });

const PreferenceOrderSchema = z.array(z.array(ReleaseIdSchema).min(1).max(4)).max(4);

const PreferenceReceiptBaseSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceReceipt.v1"),
  id: ReleaseIdSchema,
  assignmentRef: ImmutableReleaseRefSchema,
  reviewer: z.object({
    kind: PreferenceReviewerKindSchema,
    releaseRef: ImmutableReleaseRefSchema,
  }).strict(),
  order: PreferenceOrderSchema,
  rejectAll: z.boolean(),
  criterionScores: z.record(ReleaseIdSchema, z.record(ReleaseIdSchema, z.number().finite().min(0).max(1))),
  feedbackArtifactRef: ImmutableArtifactRefSchema.nullable(),
  startedAt: ReleaseTimestampSchema,
  completedAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.rejectAll && receipt.order.length !== 0) {
    context.addIssue({ code: "custom", path: ["order"], message: "A reject-all preference receipt cannot contain an order." });
  }
  if (!receipt.rejectAll && receipt.order.length === 0) {
    context.addIssue({ code: "custom", path: ["order"], message: "A non-reject preference receipt requires an ordered result." });
  }
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "A preference receipt cannot complete before it starts." });
  }
});
export const PreferenceReceiptContentSchema = PreferenceReceiptBaseSchema;
export const PreferenceReceiptSchema = PreferenceReceiptBaseSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

const PreferenceAggregateSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceAggregationReceipt.v1"),
  id: ReleaseIdSchema,
  assignmentRef: ImmutableReleaseRefSchema,
  comparisonRelease: ImmutableReleaseRefSchema,
  receiptRefs: z.array(ImmutableReleaseRefSchema).min(1).max(100),
  order: PreferenceOrderSchema,
  rejectAll: z.boolean(),
  pairwiseWinFractions: z.record(ReleaseIdSchema, z.number().min(0).max(1)),
  quorum: z.number().int().positive().max(100),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict().superRefine((aggregate, context) => {
  if (aggregate.rejectAll && aggregate.order.length !== 0) {
    context.addIssue({ code: "custom", path: ["order"], message: "A reject-all aggregate cannot contain an order." });
  }
});
export const PreferenceAggregationReceiptContentSchema = PreferenceAggregateSchema;
export const PreferenceAggregationReceiptSchema = PreferenceAggregateSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

const PreferenceCalibrationReportBaseSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceCalibrationReport.v1"),
  id: ReleaseIdSchema,
  comparisonRelease: ImmutableReleaseRefSchema,
  automatedReviewer: ImmutableReleaseRefSchema,
  humanReceiptRefs: z.array(ImmutableReleaseRefSchema).min(1).max(100_000),
  modelReceiptRefs: z.array(ImmutableReleaseRefSchema).min(1).max(100_000),
  sampleCount: z.number().int().positive().max(100_000),
  orderAgreement: z.number().min(0).max(1),
  tieAgreement: z.number().min(0).max(1),
  orderSwapAgreement: z.number().min(0).max(1),
  passed: z.boolean(),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict();
export const PreferenceCalibrationReportContentSchema = PreferenceCalibrationReportBaseSchema;
export const PreferenceCalibrationReportSchema = PreferenceCalibrationReportBaseSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

export function createPreferenceComparisonRelease(
  input: z.input<typeof PreferenceComparisonReleaseContentSchema>,
): PreferenceComparisonRelease {
  const content = PreferenceComparisonReleaseContentSchema.parse(input);
  return PreferenceComparisonReleaseSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyPreferenceComparisonRelease(value: unknown): value is PreferenceComparisonRelease {
  return verifyHashed(value, PreferenceComparisonReleaseContentSchema, PreferenceComparisonReleaseSchema);
}

export function createComparisonAssignment(input: {
  id: string;
  comparisonRelease: PreferenceComparisonRelease;
  taskset: TasksetRelease;
  candidates: readonly ComparisonAssignmentCandidateInput[];
  harnessCompatibilityReceipts?: readonly HarnessCompatibilityReceipt[];
  purpose: PreferenceComparisonPurpose;
  presentedCandidateOrder?: readonly string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}): ComparisonAssignment {
  const release = verifyComparisonRelease(input.comparisonRelease);
  const taskset = verifyTasksetRelease(input.taskset);
  if (!sameRef(release.tasksetRelease, ref(taskset))) {
    throw new Error("Preference Comparison Release does not belong to the supplied Taskset Release.");
  }
  if (input.candidates.length !== release.candidateCount) {
    throw new Error("Comparison assignment candidate count does not match the immutable comparison release.");
  }
  const normalized = input.candidates.map((candidate) => validateComparisonCandidate(candidate, taskset));
  const first = normalized[0]!;
  for (const candidate of normalized.slice(1)) {
    if (candidate.attempt.taskId !== first.attempt.taskId) {
      throw new Error("Preference comparison candidates must belong to the same Taskset task.");
    }
    const compatibility = compatibilityForRunManifests(
      first.runManifest,
      candidate.runManifest,
      input.harnessCompatibilityReceipts ?? [],
    );
    if (compatibility && sameRef(compatibility.baseHarnessRelease, candidate.runManifest.harnessRelease)) {
      assertComparableRunManifests(candidate.runManifest, first.runManifest, compatibility);
    } else {
      assertComparableRunManifests(first.runManifest, candidate.runManifest, compatibility);
    }
  }
  const task = taskset.tasks.find((record) => record.id === first.attempt.taskId);
  if (!task) throw new Error("Comparison candidates reference a task absent from the supplied Taskset Release.");
  if (!taskset.environmentRelease || !taskset.verifierSetRelease) {
    throw new Error("Preference comparison requires a Taskset bound to immutable Environment and Verifier Set Releases.");
  }
  const candidateIds = normalized.map((candidate) => candidate.attempt.id);
  const presentedCandidateOrder = [...(input.presentedCandidateOrder ?? candidateIds)];
  const content = ComparisonAssignmentContentSchema.parse({
    schemaVersion: "openpond.comparisonAssignment.v1",
    id: input.id,
    comparisonRelease: ref(release),
    taskRef: {
      id: task.id,
      contentHash: contentHash({ taskId: task.id, tasksetRelease: ref(taskset) }),
    },
    lineage: {
      tasksetRelease: ref(taskset),
      harnessReleases: uniqueRefs(normalized.map((candidate) => candidate.runManifest.harnessRelease)),
      runManifestRefs: uniqueRefs(normalized.map((candidate) => ref(candidate.runManifest))),
      harnessCompatibilityReceiptRefs: uniqueRefs((input.harnessCompatibilityReceipts ?? []).map(ref)),
      environmentRelease: taskset.environmentRelease,
      verifierSetRelease: taskset.verifierSetRelease,
      toolContractHash: contentHash(taskset.tools),
      policyHash: contentHash(taskset.policy),
    },
    candidates: normalized.map((candidate) => ({
      attemptRef: ref(candidate.attempt),
      runManifestRef: ref(candidate.runManifest),
      artifactManifestRef: ref(candidate.artifactManifest),
      visibleArtifactIds: [...candidate.visibleArtifactIds],
    })),
    presentedCandidateOrder,
    purpose: input.purpose,
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
  return ComparisonAssignmentSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyComparisonAssignment(value: unknown): value is ComparisonAssignment {
  return verifyHashed(value, ComparisonAssignmentContentSchema, ComparisonAssignmentSchema);
}

export function validateComparisonAssignment(
  assignment: ComparisonAssignment,
  release: PreferenceComparisonRelease,
): void {
  const parsedAssignment = verifyAssignment(assignment);
  const parsedRelease = verifyComparisonRelease(release);
  if (!sameRef(parsedAssignment.comparisonRelease, ref(parsedRelease))) {
    throw new Error("Comparison assignment does not reference the supplied comparison release.");
  }
  if (parsedAssignment.candidates.length !== parsedRelease.candidateCount) {
    throw new Error("Comparison assignment does not satisfy its release candidate count.");
  }
}

export function createPreferenceReceipt(input: {
  id: string;
  assignment: ComparisonAssignment;
  comparisonRelease: PreferenceComparisonRelease;
  reviewer: PreferenceReviewer;
  order: readonly (readonly string[])[];
  rejectAll: boolean;
  criterionScores?: Record<string, Record<string, number>>;
  feedbackArtifactRef?: z.input<typeof ImmutableArtifactRefSchema> | null;
  startedAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}): PreferenceReceipt {
  const assignment = verifyAssignment(input.assignment);
  const release = verifyComparisonRelease(input.comparisonRelease);
  validateComparisonAssignment(assignment, release);
  const content = PreferenceReceiptContentSchema.parse({
    schemaVersion: "openpond.preferenceReceipt.v1",
    id: input.id,
    assignmentRef: ref(assignment),
    reviewer: input.reviewer,
    order: input.order.map((group) => [...group]),
    rejectAll: input.rejectAll,
    criterionScores: input.criterionScores ?? {},
    feedbackArtifactRef: input.feedbackArtifactRef ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    metadata: input.metadata ?? {},
  });
  validatePreferenceResult({ order: content.order, rejectAll: content.rejectAll }, assignment, release);
  validateCriterionScores(content.criterionScores, assignment, release);
  return PreferenceReceiptSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyPreferenceReceipt(value: unknown): value is PreferenceReceipt {
  return verifyHashed(value, PreferenceReceiptContentSchema, PreferenceReceiptSchema);
}

export function aggregatePreferenceReceipts(input: {
  id: string;
  assignment: ComparisonAssignment;
  comparisonRelease: PreferenceComparisonRelease;
  receipts: readonly PreferenceReceipt[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}): PreferenceAggregationReceipt {
  const assignment = verifyAssignment(input.assignment);
  const release = verifyComparisonRelease(input.comparisonRelease);
  validateComparisonAssignment(assignment, release);
  const receipts = input.receipts.map((receipt) => verifyReceipt(receipt));
  if (receipts.length < release.aggregation.quorum) {
    throw new Error(`Preference aggregation requires a quorum of ${release.aggregation.quorum} receipts.`);
  }
  for (const receipt of receipts) {
    if (!sameRef(receipt.assignmentRef, ref(assignment))) {
      throw new Error("Preference aggregation receipts must belong to the same assignment.");
    }
    validatePreferenceResult(receipt, assignment, release);
  }
  const rejectCount = receipts.filter((receipt) => receipt.rejectAll).length;
  const rejectAll = rejectCount / receipts.length >= release.aggregation.rejectAllThreshold;
  const scores = pairwiseScoresForReceipts(receipts, assignment);
  const order = rejectAll ? [] : orderForScores(scores, assignment);
  const content = PreferenceAggregationReceiptContentSchema.parse({
    schemaVersion: "openpond.preferenceAggregationReceipt.v1",
    id: input.id,
    assignmentRef: ref(assignment),
    comparisonRelease: ref(release),
    receiptRefs: receipts.map(ref),
    order,
    rejectAll,
    pairwiseWinFractions: scores,
    quorum: release.aggregation.quorum,
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
  return PreferenceAggregationReceiptSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyPreferenceAggregationReceipt(value: unknown): value is PreferenceAggregationReceipt {
  return verifyHashed(value, PreferenceAggregationReceiptContentSchema, PreferenceAggregationReceiptSchema);
}

export function createPreferenceCalibrationReport(input: {
  id: string;
  comparisonRelease: PreferenceComparisonRelease;
  pairs: readonly PreferenceCalibrationPair[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}): PreferenceCalibrationReport {
  const release = verifyComparisonRelease(input.comparisonRelease);
  if (input.pairs.length < release.calibration.minimumSamples) {
    throw new Error(`Preference calibration requires at least ${release.calibration.minimumSamples} human/model pairs.`);
  }
  const normalized = input.pairs.map((pair) => validateCalibrationPair(pair, release));
  const firstReviewer = normalized[0]!.model.reviewer.releaseRef;
  if (normalized.some((pair) => !sameRef(pair.model.reviewer.releaseRef, firstReviewer))) {
    throw new Error("Preference calibration requires model receipts from one immutable automated reviewer release.");
  }
  const orderAgreement = mean(normalized.map((pair) => pairwiseAgreement(pair.human, pair.model, pair.assignment)));
  const tieAgreement = mean(normalized.map((pair) => tieAgreementScore(pair.human, pair.model, pair.assignment)));
  const orderSwapAgreement = mean(normalized.map((pair) => pair.swappedModel
    ? pairwiseAgreement(pair.model, pair.swappedModel, pair.assignment)
    : 1));
  const passed = orderAgreement >= release.calibration.minimumOrderAgreement
    && tieAgreement >= release.calibration.minimumTieAgreement
    && orderSwapAgreement >= release.calibration.minimumOrderSwapAgreement;
  const content = PreferenceCalibrationReportContentSchema.parse({
    schemaVersion: "openpond.preferenceCalibrationReport.v1",
    id: input.id,
    comparisonRelease: ref(release),
    automatedReviewer: firstReviewer,
    humanReceiptRefs: normalized.map((pair) => ref(pair.human)),
    modelReceiptRefs: normalized.map((pair) => ref(pair.model)),
    sampleCount: normalized.length,
    orderAgreement,
    tieAgreement,
    orderSwapAgreement,
    passed,
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
  return PreferenceCalibrationReportSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyPreferenceCalibrationReport(value: unknown): value is PreferenceCalibrationReport {
  return verifyHashed(value, PreferenceCalibrationReportContentSchema, PreferenceCalibrationReportSchema);
}

export function projectPairwiseWinFraction(input: {
  assignment: ComparisonAssignment;
  comparisonRelease: PreferenceComparisonRelease;
  result: PreferenceReceipt | PreferenceAggregationReceipt;
}): Record<string, number> {
  const assignment = verifyAssignment(input.assignment);
  const release = verifyComparisonRelease(input.comparisonRelease);
  validateComparisonAssignment(assignment, release);
  if (input.result.schemaVersion === "openpond.preferenceReceipt.v1") {
    const receipt = verifyReceipt(input.result);
    if (!sameRef(receipt.assignmentRef, ref(assignment))) {
      throw new Error("Preference receipt does not belong to the supplied assignment.");
    }
    validatePreferenceResult(receipt, assignment, release);
    return pairwiseScoresForResult(receipt, assignment);
  }
  const aggregate = verifyAggregate(input.result);
  if (!sameRef(aggregate.assignmentRef, ref(assignment)) || !sameRef(aggregate.comparisonRelease, ref(release))) {
    throw new Error("Preference aggregate does not belong to the supplied assignment and release.");
  }
  validatePreferenceResult(aggregate, assignment, release);
  return aggregate.rejectAll ? zeroScores(assignment) : aggregate.pairwiseWinFractions;
}

export function createPreferenceRewardComponents(input: {
  assignment: ComparisonAssignment;
  comparisonRelease: PreferenceComparisonRelease;
  result: PreferenceReceipt | PreferenceAggregationReceipt;
  calibrationReport?: PreferenceCalibrationReport | null;
  candidates?: readonly PreferenceCandidateEligibility[];
}): Record<string, RewardComponentReceipt> {
  const assignment = verifyAssignment(input.assignment);
  const release = verifyComparisonRelease(input.comparisonRelease);
  const scores = projectPairwiseWinFraction({ assignment, comparisonRelease: release, result: input.result });
  const eligible = new Map((input.candidates ?? []).map((candidate) => [candidate.attemptRef.id, candidate]));
  const modelReceipt = input.result.schemaVersion === "openpond.preferenceReceipt.v1"
    ? input.result
    : null;
  const automatedReceipt = modelReceipt?.reviewer.kind === "model";
  const calibrated = !automatedReceipt || isCalibratedAutomatedReviewer(modelReceipt!, release, input.calibrationReport ?? null);
  return Object.fromEntries(assignment.candidates.map((candidate) => {
    const candidateEligibility = eligible.get(candidate.attemptRef.id);
    const canScore = candidateEligibility?.eligible ?? true;
    const score = scores[candidate.attemptRef.id]!;
    const component = canScore && calibrated
      ? RewardComponentReceiptSchema.parse({
        verifierId: release.rewardProjection.verifierId,
        verifierVersion: release.rewardProjection.verifierVersion,
        status: "scored",
        rawScore: score,
        normalizedScore: score,
        weight: release.rewardProjection.weight,
        passed: score > 0,
        hardGate: false,
        rewardEligible: true,
        rewardContribution: score,
        failureOwner: null,
        feedback: [],
        visibleEvidenceRefs: [],
        privilegedEvidenceRefs: [],
        metadata: {
          comparisonAssignment: ref(assignment),
          preferenceResult: ref(input.result),
          ...(input.calibrationReport ? { calibrationReport: ref(input.calibrationReport) } : {}),
        },
      })
      : RewardComponentReceiptSchema.parse({
        verifierId: release.rewardProjection.verifierId,
        verifierVersion: release.rewardProjection.verifierVersion,
        status: "unscorable",
        rawScore: null,
        normalizedScore: null,
        weight: release.rewardProjection.weight,
        passed: false,
        hardGate: false,
        rewardEligible: false,
        rewardContribution: null,
        failureOwner: candidateEligibility?.failureOwner ?? "verifier",
        feedback: [canScore ? "Automated preference reviewer is uncalibrated or inconsistent." : "Candidate is not eligible for comparative preference scoring."],
        visibleEvidenceRefs: [],
        privilegedEvidenceRefs: [],
        metadata: {
          comparisonAssignment: ref(assignment),
          preferenceResult: ref(input.result),
          ...(input.calibrationReport ? { calibrationReport: ref(input.calibrationReport) } : {}),
        },
      });
    return [candidate.attemptRef.id, component];
  }));
}

function validateComparisonCandidate(input: ComparisonAssignmentCandidateInput, taskset: TasksetRelease): ValidatedComparisonCandidate {
  const attempt = AttemptReceiptSchema.parse(input.attempt);
  if (!verifyAttemptReceipt(attempt)) throw new Error("Comparison candidate Attempt Receipt has an invalid content hash.");
  const artifactManifest = ArtifactManifestSchema.parse(input.artifactManifest);
  if (!verifyArtifactManifest(artifactManifest)) throw new Error("Comparison candidate Artifact Manifest has an invalid content hash.");
  const runManifest = RunManifestSchema.parse(input.runManifest);
  if (!verifyRunManifest(runManifest)) throw new Error("Comparison candidate Run Manifest has an invalid content hash.");
  if (!sameRef(attempt.runManifest, ref(runManifest))) {
    throw new Error("Comparison candidate Attempt Receipt does not belong to its supplied Run Manifest.");
  }
  if (!sameRef(runManifest.tasksetRelease, ref(taskset))) {
    throw new Error("Comparison candidate Run Manifest does not belong to the supplied Taskset Release.");
  }
  if (!sameRef(artifactManifest.attemptRef, ref(attempt))) {
    throw new Error("Comparison candidate Artifact Manifest does not belong to its Attempt Receipt.");
  }
  if (!attempt.terminal || attempt.failureClass !== null) {
    throw new Error("Only completed, non-failed attempts can be assigned for comparative review.");
  }
  const visibleArtifactIds = [...input.visibleArtifactIds];
  const visible = new Set(visibleArtifactIds);
  const available = new Set(
    artifactManifest.entries
      .filter((entry) => entry.status === "collected" && entry.artifact !== null)
      .map((entry) => entry.artifact!.id),
  );
  if (!visibleArtifactIds.length || visibleArtifactIds.some((id) => !available.has(id))) {
    throw new Error("Comparison candidate exposes an artifact that is missing, uncollected, or unreviewable.");
  }
  if (visible.size !== visibleArtifactIds.length) throw new Error("Comparison candidate visible artifacts must be unique.");
  return { attempt, artifactManifest, runManifest, visibleArtifactIds };
}

function validatePreferenceResult(
  result: Pick<PreferenceReceipt, "order" | "rejectAll">,
  assignment: ComparisonAssignment,
  release: PreferenceComparisonRelease,
): void {
  const candidateIds = assignment.candidates.map((candidate) => candidate.attemptRef.id);
  if (result.rejectAll) {
    if (!release.allowRejectAll) throw new Error("This comparison release does not allow reject-all results.");
    if (result.order.length) throw new Error("Reject-all results cannot include ordered candidates.");
    return;
  }
  const flattened = result.order.flat();
  if (new Set(flattened).size !== flattened.length || flattened.length !== candidateIds.length || flattened.some((id) => !candidateIds.includes(id))) {
    throw new Error("Preference result must rank every assignment candidate exactly once.");
  }
  if (!release.allowTies && result.order.some((group) => group.length > 1)) {
    throw new Error("This comparison release does not allow tied candidates.");
  }
}

function validateCriterionScores(
  scores: Record<string, Record<string, number>>,
  assignment: ComparisonAssignment,
  release: PreferenceComparisonRelease,
): void {
  const candidateIds = new Set(assignment.candidates.map((candidate) => candidate.attemptRef.id));
  const criteria = new Set(release.criteria.map((criterion) => criterion.id));
  for (const [candidateId, candidateScores] of Object.entries(scores)) {
    if (!candidateIds.has(candidateId)) throw new Error("Criterion scores include a candidate absent from the assignment.");
    for (const criterionId of Object.keys(candidateScores)) {
      if (!criteria.has(criterionId)) throw new Error("Criterion scores include a criterion absent from the comparison release.");
    }
  }
}

function pairwiseScoresForReceipts(receipts: readonly PreferenceReceipt[], assignment: ComparisonAssignment): Record<string, number> {
  const sums = zeroScores(assignment);
  for (const receipt of receipts) {
    const scores = pairwiseScoresForResult(receipt, assignment);
    for (const [candidateId, score] of Object.entries(scores)) sums[candidateId]! += score;
  }
  return Object.fromEntries(Object.entries(sums).map(([candidateId, score]) => [candidateId, score / receipts.length]));
}

function pairwiseScoresForResult(
  result: Pick<PreferenceReceipt, "order" | "rejectAll">,
  assignment: ComparisonAssignment,
): Record<string, number> {
  if (result.rejectAll) return zeroScores(assignment);
  const candidateIds = assignment.candidates.map((candidate) => candidate.attemptRef.id);
  const rank = new Map(result.order.flatMap((group, index) => group.map((candidateId) => [candidateId, index])));
  return Object.fromEntries(candidateIds.map((candidateId) => {
    const position = rank.get(candidateId);
    if (position === undefined) throw new Error("Preference result is missing a comparison candidate.");
    let total = 0;
    for (const opponentId of candidateIds) {
      if (opponentId === candidateId) continue;
      const opponentPosition = rank.get(opponentId);
      if (opponentPosition === undefined) throw new Error("Preference result is missing a comparison candidate.");
      total += position < opponentPosition ? 1 : position === opponentPosition ? 0.5 : 0;
    }
    return [candidateId, total / (candidateIds.length - 1)];
  }));
}

function orderForScores(scores: Record<string, number>, assignment: ComparisonAssignment): string[][] {
  const ids = assignment.candidates.map((candidate) => candidate.attemptRef.id);
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const key = scores[id]!.toPrecision(12);
    const value = Number(key);
    groups.set(value, [...(groups.get(value) ?? []), id]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, candidateIds]) => candidateIds.sort((left, right) => ids.indexOf(left) - ids.indexOf(right)));
}

function pairwiseAgreement(left: PreferenceReceipt, right: PreferenceReceipt, assignment: ComparisonAssignment): number {
  const ids = assignment.candidates.map((candidate) => candidate.attemptRef.id);
  const pairs = pairsFor(ids);
  if (!pairs.length) return 1;
  return mean(pairs.map(([first, second]) => pairRelation(left, first, second) === pairRelation(right, first, second) ? 1 : 0));
}

function tieAgreementScore(left: PreferenceReceipt, right: PreferenceReceipt, assignment: ComparisonAssignment): number {
  const pairs = pairsFor(assignment.candidates.map((candidate) => candidate.attemptRef.id));
  if (!pairs.length) return 1;
  return mean(pairs.map(([first, second]) => (pairRelation(left, first, second) === 0) === (pairRelation(right, first, second) === 0) ? 1 : 0));
}

function pairRelation(result: Pick<PreferenceReceipt, "order" | "rejectAll">, first: string, second: string): -1 | 0 | 1 {
  if (result.rejectAll) return 0;
  const rank = new Map(result.order.flatMap((group, index) => group.map((candidate) => [candidate, index])));
  const firstRank = rank.get(first);
  const secondRank = rank.get(second);
  if (firstRank === undefined || secondRank === undefined) throw new Error("Preference result does not cover all comparison candidates.");
  return firstRank < secondRank ? 1 : firstRank === secondRank ? 0 : -1;
}

function pairsFor(ids: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < ids.length; index += 1) {
    for (let other = index + 1; other < ids.length; other += 1) pairs.push([ids[index]!, ids[other]!]);
  }
  return pairs;
}

function validateCalibrationPair(pair: PreferenceCalibrationPair, release: PreferenceComparisonRelease): ValidatedCalibrationPair {
  const assignment = verifyAssignment(pair.assignment);
  validateComparisonAssignment(assignment, release);
  if (assignment.purpose === "frozen_eval") {
    throw new Error("Frozen-evaluation comparisons cannot calibrate an automated preference reviewer.");
  }
  const human = verifyReceipt(pair.human);
  const model = verifyReceipt(pair.model);
  if (human.reviewer.kind !== "human" || model.reviewer.kind !== "model") {
    throw new Error("Preference calibration requires one human and one automated model receipt per assignment.");
  }
  if (!sameRef(human.assignmentRef, ref(assignment)) || !sameRef(model.assignmentRef, ref(assignment))) {
    throw new Error("Preference calibration receipts must belong to their supplied assignment.");
  }
  validatePreferenceResult(human, assignment, release);
  validatePreferenceResult(model, assignment, release);
  const swappedModel = pair.swappedModel ? verifyReceipt(pair.swappedModel) : null;
  if (swappedModel) {
    if (swappedModel.reviewer.kind !== "model" || !sameRef(swappedModel.assignmentRef, ref(assignment))) {
      throw new Error("Order-swap calibration receipts must be model receipts for the same assignment.");
    }
    if (!sameRef(swappedModel.reviewer.releaseRef, model.reviewer.releaseRef)) {
      throw new Error("Order-swap calibration must use the same immutable automated reviewer release.");
    }
    validatePreferenceResult(swappedModel, assignment, release);
  }
  return { assignment, human, model, swappedModel };
}

function isCalibratedAutomatedReviewer(
  receipt: PreferenceReceipt,
  release: PreferenceComparisonRelease,
  report: PreferenceCalibrationReport | null,
): boolean {
  if (!report || !verifyPreferenceCalibrationReport(report)) return false;
  return report.passed
    && sameRef(report.comparisonRelease, ref(release))
    && sameRef(report.automatedReviewer, receipt.reviewer.releaseRef);
}

function zeroScores(assignment: ComparisonAssignment): Record<string, number> {
  return Object.fromEntries(assignment.candidates.map((candidate) => [candidate.attemptRef.id, 0]));
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function ref(value: { id: string; contentHash: string }): { id: string; contentHash: string } {
  return { id: value.id, contentHash: value.contentHash };
}

function sameRef(left: { id: string; contentHash: string }, right: { id: string; contentHash: string }): boolean {
  return left.id === right.id && left.contentHash === right.contentHash;
}

function uniqueRefs<T extends { id: string; contentHash: string }>(refs: readonly T[]): T[] {
  return [...new Map(refs.map((value) => [`${value.id}:${value.contentHash}`, value])).values()];
}

function compatibilityForRunManifests(
  base: RunManifest,
  candidate: RunManifest,
  receipts: readonly HarnessCompatibilityReceipt[],
): HarnessCompatibilityReceipt | undefined {
  if (sameRef(base.harnessRelease, candidate.harnessRelease)) return undefined;
  return receipts.find((receipt) =>
    sameRef(receipt.tasksetRelease, base.tasksetRelease)
    && ((sameRef(receipt.baseHarnessRelease, base.harnessRelease)
      && sameRef(receipt.candidateHarnessRelease, candidate.harnessRelease))
      || (sameRef(receipt.baseHarnessRelease, candidate.harnessRelease)
        && sameRef(receipt.candidateHarnessRelease, base.harnessRelease))),
  );
}

function verifyHashed<T extends Record<string, unknown>>(
  value: unknown,
  contentSchema: { parse(input: unknown): T },
  fullSchema: { safeParse(input: unknown): { success: boolean; data?: T & { contentHash: string } } },
): boolean {
  const parsed = fullSchema.safeParse(value);
  if (!parsed.success || !parsed.data) return false;
  const { contentHash: actual, ...content } = parsed.data;
  try {
    return contentHash(contentSchema.parse(content)) === actual;
  } catch {
    return false;
  }
}

function verifyComparisonRelease(value: PreferenceComparisonRelease): PreferenceComparisonRelease {
  if (!verifyPreferenceComparisonRelease(value)) throw new Error("Preference Comparison Release has an invalid content hash.");
  return value;
}

function verifyAssignment(value: ComparisonAssignment): ComparisonAssignment {
  if (!verifyComparisonAssignment(value)) throw new Error("Comparison Assignment has an invalid content hash.");
  return value;
}

function verifyReceipt(value: PreferenceReceipt): PreferenceReceipt {
  if (!verifyPreferenceReceipt(value)) throw new Error("Preference Receipt has an invalid content hash.");
  return value;
}

function verifyAggregate(value: PreferenceAggregationReceipt): PreferenceAggregationReceipt {
  if (!verifyPreferenceAggregationReceipt(value)) throw new Error("Preference Aggregation Receipt has an invalid content hash.");
  return value;
}

function verifyTasksetRelease(value: TasksetRelease): TasksetRelease {
  const { contentHash: actual, ...content } = TasksetReleaseSchema.parse(value);
  if (contentHash(TasksetReleaseContentSchema.parse(content)) !== actual) {
    throw new Error("Taskset Release has an invalid content hash.");
  }
  return value;
}

function verifyArtifactManifest(value: ArtifactManifest): boolean {
  const parsed = ArtifactManifestSchema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return contentHash(ArtifactManifestContentSchema.parse(content)) === actual;
}

function verifyRunManifest(value: RunManifest): boolean {
  const parsed = RunManifestSchema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return contentHash(content) === actual;
}

export type PreferenceComparisonPurpose = z.infer<typeof PreferenceComparisonPurposeSchema>;
export type PreferenceReviewerKind = z.infer<typeof PreferenceReviewerKindSchema>;
export type PreferenceComparisonRelease = z.infer<typeof PreferenceComparisonReleaseSchema>;
export type ComparisonAssignment = z.infer<typeof ComparisonAssignmentSchema>;
export type PreferenceReceipt = z.infer<typeof PreferenceReceiptSchema>;
export type PreferenceAggregationReceipt = z.infer<typeof PreferenceAggregationReceiptSchema>;
export type PreferenceCalibrationReport = z.infer<typeof PreferenceCalibrationReportSchema>;
export type PreferenceReviewer = z.infer<typeof PreferenceReceiptSchema>["reviewer"];
export type ComparisonAssignmentCandidateInput = {
  attempt: AttemptReceipt;
  artifactManifest: ArtifactManifest;
  runManifest: RunManifest;
  visibleArtifactIds: readonly string[];
};
export type PreferenceCandidateEligibility = {
  attemptRef: { id: string; contentHash: string };
  eligible: boolean;
  failureOwner?: FailureOwner;
};
export type PreferenceCalibrationPair = {
  assignment: ComparisonAssignment;
  human: PreferenceReceipt;
  model: PreferenceReceipt;
  swappedModel?: PreferenceReceipt;
};

type ValidatedComparisonCandidate = {
  attempt: AttemptReceipt;
  artifactManifest: ArtifactManifest;
  runManifest: RunManifest;
  visibleArtifactIds: string[];
};
type ValidatedCalibrationPair = {
  assignment: ComparisonAssignment;
  human: PreferenceReceipt;
  model: PreferenceReceipt;
  swappedModel: PreferenceReceipt | null;
};
