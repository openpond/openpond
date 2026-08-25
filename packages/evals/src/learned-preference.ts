import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  contentHash,
} from "@openpond/harness";
import {
  verifyComparisonAssignment,
  verifyPreferenceReceipt,
  type ComparisonAssignment,
  type PreferenceComparisonRelease,
  type PreferenceReceipt,
} from "./preferences.js";
import type { TasksetRelease } from "./tasksets.js";

const PreferenceDatasetPartitionSchema = z.enum([
  "reward_train",
  "reward_validation",
  "reward_qualification",
]);

export const PreferenceEvidenceAuthoritySchema = z.enum([
  "human",
  "synthetic_fixture",
]);

export const RewardModelQualificationKindSchema = z.enum([
  "synthetic_smoke",
  "human_heldout",
]);

const PreferenceDatasetGroupSchema = z.object({
  id: ReleaseIdSchema,
  assignmentRef: ImmutableReleaseRefSchema,
  scenarioRef: ImmutableReleaseRefSchema,
  scenarioSplit: z.enum(["train", "validation"]),
  preferenceResultRef: ImmutableReleaseRefSchema,
  receiptRefs: z.array(ImmutableReleaseRefSchema).min(1).max(100),
  attemptRefs: z.array(ImmutableReleaseRefSchema).min(2).max(4),
  artifactManifestRefs: z.array(ImmutableReleaseRefSchema).min(2).max(4),
  orderedBuckets: z.array(z.array(ReleaseIdSchema).min(1).max(4)).max(4),
  rejectAll: z.boolean(),
  partition: PreferenceDatasetPartitionSchema,
  metadata: MetadataSchema,
}).strict().superRefine((group, context) => {
  const attemptIds = group.attemptRefs.map((attempt) => attempt.id);
  if (new Set(attemptIds).size !== attemptIds.length) {
    context.addIssue({
      code: "custom",
      path: ["attemptRefs"],
      message: "Preference dataset group Attempt refs must be unique.",
    });
  }
  if (group.artifactManifestRefs.length !== group.attemptRefs.length) {
    context.addIssue({
      code: "custom",
      path: ["artifactManifestRefs"],
      message: "Every preference dataset Attempt requires one Artifact Manifest ref.",
    });
  }
  const bucketIds = group.orderedBuckets.flat();
  if (group.rejectAll && bucketIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["orderedBuckets"],
      message: "A reject-all preference dataset group cannot contain ordered buckets.",
    });
  }
  if (
    !group.rejectAll
    && (
      bucketIds.length !== attemptIds.length
      || new Set(bucketIds).size !== bucketIds.length
      || bucketIds.some((attemptId) => !attemptIds.includes(attemptId))
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["orderedBuckets"],
      message: "Ordered buckets must contain every group Attempt exactly once.",
    });
  }
});

const PreferenceDatasetPairSchema = z.object({
  groupId: ReleaseIdSchema,
  preferredAttemptRef: ImmutableReleaseRefSchema,
  dispreferredAttemptRef: ImmutableReleaseRefSchema,
  relation: z.enum(["preferred", "tie"]),
}).strict().superRefine((pair, context) => {
  if (
    pair.preferredAttemptRef.id === pair.dispreferredAttemptRef.id
    && pair.preferredAttemptRef.contentHash === pair.dispreferredAttemptRef.contentHash
  ) {
    context.addIssue({
      code: "custom",
      message: "A derived preference pair must reference two different Attempts.",
    });
  }
});

export const PreferenceDatasetReleaseContentSchema = z.object({
  schemaVersion: z.literal("openpond.preferenceDatasetRelease.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  tasksetRelease: ImmutableReleaseRefSchema,
  comparisonRelease: ImmutableReleaseRefSchema,
  authority: PreferenceEvidenceAuthoritySchema,
  qualificationEligibility: z.enum(["smoke_only", "human_heldout"]),
  fixtureRelease: ImmutableReleaseRefSchema.nullable(),
  groups: z.array(PreferenceDatasetGroupSchema).min(1).max(100_000),
  derivedPairs: z.array(PreferenceDatasetPairSchema).max(1_000_000),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict().superRefine((release, context) => {
  if (
    release.authority === "synthetic_fixture"
    && (
      release.qualificationEligibility !== "smoke_only"
      || release.fixtureRelease === null
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["qualificationEligibility"],
      message: "Synthetic preference datasets require a fixture release and are smoke-only.",
    });
  }
  if (
    release.authority === "human"
    && (
      release.qualificationEligibility !== "human_heldout"
      || release.fixtureRelease !== null
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["authority"],
      message: "Human preference datasets must be human-heldout eligible and cannot bind a fixture release.",
    });
  }
  const groupIds = release.groups.map((group) => group.id);
  if (new Set(groupIds).size !== groupIds.length) {
    context.addIssue({
      code: "custom",
      path: ["groups"],
      message: "Preference dataset group IDs must be unique.",
    });
  }
  const groups = new Map(release.groups.map((group) => [group.id, group]));
  for (const [index, pair] of release.derivedPairs.entries()) {
    const group = groups.get(pair.groupId);
    if (!group) {
      context.addIssue({
        code: "custom",
        path: ["derivedPairs", index, "groupId"],
        message: "Derived preference pairs must reference a group in the same release.",
      });
      continue;
    }
    const attemptIds = new Set(group.attemptRefs.map((attempt) => attempt.id));
    if (
      !attemptIds.has(pair.preferredAttemptRef.id)
      || !attemptIds.has(pair.dispreferredAttemptRef.id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["derivedPairs", index],
        message: "Derived preference pairs must reference Attempts in their source group.",
      });
    }
  }
});

export const PreferenceDatasetReleaseSchema = PreferenceDatasetReleaseContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

const RewardModelQualificationMetricsSchema = z.object({
  sampleCount: z.number().int().positive(),
  finiteScoreRate: z.number().min(0).max(1),
  scoreVariance: z.number().nonnegative(),
  checkpointReloadPassed: z.boolean(),
  processorCompatibilityPassed: z.boolean(),
  invalidAttemptExclusionPassed: z.boolean(),
  orderedPairAccuracy: z.number().min(0).max(1).nullable(),
  bucketAccuracy: z.number().min(0).max(1).nullable(),
  tieAgreement: z.number().min(0).max(1).nullable(),
}).strict();

export const RewardModelQualificationReportContentSchema = z.object({
  schemaVersion: z.literal("openpond.rewardModelQualificationReport.v1"),
  id: ReleaseIdSchema,
  kind: RewardModelQualificationKindSchema,
  rewardModelVersion: ImmutableReleaseRefSchema,
  preferenceDatasetRelease: ImmutableReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  processorRelease: ImmutableReleaseRefSchema,
  metrics: RewardModelQualificationMetricsSchema,
  passed: z.boolean(),
  productionRewardEligible: z.boolean(),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict().superRefine((report, context) => {
  if (report.kind === "synthetic_smoke" && report.productionRewardEligible) {
    context.addIssue({
      code: "custom",
      path: ["productionRewardEligible"],
      message: "Synthetic-smoke Reward Model qualification can never grant production reward eligibility.",
    });
  }
  if (
    report.kind === "human_heldout"
    && report.productionRewardEligible !== report.passed
  ) {
    context.addIssue({
      code: "custom",
      path: ["productionRewardEligible"],
      message: "Human-heldout reward eligibility must match the frozen qualification outcome.",
    });
  }
});

export const RewardModelQualificationReportSchema =
  RewardModelQualificationReportContentSchema
    .extend({ contentHash: ReleaseHashSchema })
    .strict();

export function createPreferenceDatasetRelease(
  input: z.input<typeof PreferenceDatasetReleaseContentSchema>,
): PreferenceDatasetRelease {
  const content = PreferenceDatasetReleaseContentSchema.parse(input);
  return PreferenceDatasetReleaseSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

export function materializePreferenceDatasetRelease(input: {
  id: string;
  revision: number;
  tasksetRelease: TasksetRelease;
  comparisonRelease: PreferenceComparisonRelease;
  authority: "human" | "synthetic_fixture";
  groups: ReadonlyArray<{
    assignment: ComparisonAssignment;
    receipt: PreferenceReceipt;
    partition: z.infer<typeof PreferenceDatasetPartitionSchema>;
  }>;
  createdAt: string;
  metadata?: Record<string, unknown>;
}): PreferenceDatasetRelease {
  if (input.groups.length === 0) {
    throw new Error("Preference dataset materialization requires at least one reviewed group.");
  }
  const tasksetRef = releaseRef(input.tasksetRelease);
  const comparisonRef = releaseRef(input.comparisonRelease);
  const fixtureRefs = new Map<string, { id: string; contentHash: string }>();
  const groups = input.groups.map(({ assignment, receipt, partition }) => {
    if (!verifyComparisonAssignment(assignment)) {
      throw new Error("Preference dataset assignment failed immutable verification.");
    }
    if (!verifyPreferenceReceipt(receipt)) {
      throw new Error("Preference dataset receipt failed immutable verification.");
    }
    if (!sameReleaseRef(assignment.lineage.tasksetRelease, tasksetRef)) {
      throw new Error("Preference dataset assignment belongs to a different Taskset release.");
    }
    if (!sameReleaseRef(assignment.comparisonRelease, comparisonRef)) {
      throw new Error("Preference dataset assignment belongs to a different comparison release.");
    }
    if (!sameReleaseRef(receipt.assignmentRef, releaseRef(assignment))) {
      throw new Error("Preference dataset receipt belongs to a different assignment.");
    }
    if (input.authority === "synthetic_fixture") {
      if (receipt.reviewer.kind !== "fixture") {
        throw new Error("Synthetic preference datasets accept only fixture receipts.");
      }
      fixtureRefs.set(receipt.reviewer.fixtureRelease.contentHash, receipt.reviewer.fixtureRelease);
    } else if (receipt.reviewer.kind !== "human") {
      throw new Error("Human preference datasets accept only human receipts.");
    }
    const scenario = input.tasksetRelease.tasks.find((task) => task.id === assignment.taskRef.id);
    if (!scenario || (scenario.split !== "train" && scenario.split !== "validation")) {
      throw new Error("Preference model datasets require train or validation scenarios.");
    }
    if (partition === "reward_train" && scenario.split !== "train") {
      throw new Error("Reward training groups must use train scenarios.");
    }
    if (partition !== "reward_train" && scenario.split !== "validation") {
      throw new Error("Reward validation and qualification groups must use validation scenarios.");
    }
    return {
      id: `preference-group:${assignment.id}`,
      assignmentRef: releaseRef(assignment),
      scenarioRef: assignment.taskRef,
      scenarioSplit: scenario.split,
      preferenceResultRef: releaseRef(receipt),
      receiptRefs: [releaseRef(receipt)],
      attemptRefs: assignment.candidates.map((candidate) => candidate.attemptRef),
      artifactManifestRefs: assignment.candidates.map((candidate) => candidate.artifactManifestRef),
      orderedBuckets: receipt.order,
      rejectAll: receipt.rejectAll,
      partition,
      metadata: { purpose: assignment.purpose, ...assignment.metadata },
    };
  });
  if (input.authority === "synthetic_fixture" && fixtureRefs.size !== 1) {
    throw new Error("Synthetic preference dataset groups must share one immutable fixture release.");
  }
  const fixtureRelease = input.authority === "synthetic_fixture"
    ? [...fixtureRefs.values()][0]!
    : null;
  return createPreferenceDatasetRelease({
    schemaVersion: "openpond.preferenceDatasetRelease.v1",
    id: input.id,
    revision: input.revision,
    tasksetRelease: tasksetRef,
    comparisonRelease: comparisonRef,
    authority: input.authority,
    qualificationEligibility: input.authority === "synthetic_fixture" ? "smoke_only" : "human_heldout",
    fixtureRelease,
    groups,
    derivedPairs: groups.flatMap(derivePairs),
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  });
}

export function verifyPreferenceDatasetRelease(
  value: unknown,
): value is PreferenceDatasetRelease {
  return verifyHashed(
    value,
    PreferenceDatasetReleaseContentSchema,
    PreferenceDatasetReleaseSchema,
  );
}

export function createRewardModelQualificationReport(
  input: z.input<typeof RewardModelQualificationReportContentSchema>,
): RewardModelQualificationReport {
  const content = RewardModelQualificationReportContentSchema.parse(input);
  return RewardModelQualificationReportSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

export function verifyRewardModelQualificationReport(
  value: unknown,
): value is RewardModelQualificationReport {
  return verifyHashed(
    value,
    RewardModelQualificationReportContentSchema,
    RewardModelQualificationReportSchema,
  );
}

function verifyHashed<T extends Record<string, unknown>>(
  value: unknown,
  contentSchema: { parse(input: unknown): T },
  fullSchema: {
    safeParse(input: unknown): {
      success: boolean;
      data?: T & { contentHash: string };
    };
  },
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

function derivePairs(group: z.infer<typeof PreferenceDatasetGroupSchema>) {
  if (group.rejectAll) return [];
  const attemptById = new Map(group.attemptRefs.map((attempt) => [attempt.id, attempt]));
  const pairs: Array<z.infer<typeof PreferenceDatasetPairSchema>> = [];
  for (const [bucketIndex, bucket] of group.orderedBuckets.entries()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        pairs.push({
          groupId: group.id,
          preferredAttemptRef: attemptById.get(bucket[left]!)!,
          dispreferredAttemptRef: attemptById.get(bucket[right]!)!,
          relation: "tie",
        });
      }
    }
    for (const lowerBucket of group.orderedBuckets.slice(bucketIndex + 1)) {
      for (const preferredId of bucket) {
        for (const dispreferredId of lowerBucket) {
          pairs.push({
            groupId: group.id,
            preferredAttemptRef: attemptById.get(preferredId)!,
            dispreferredAttemptRef: attemptById.get(dispreferredId)!,
            relation: "preferred",
          });
        }
      }
    }
  }
  return pairs;
}

function releaseRef(value: { id: string; contentHash: string }) {
  return { id: value.id, contentHash: value.contentHash };
}

function sameReleaseRef(
  left: { id: string; contentHash: string },
  right: { id: string; contentHash: string },
): boolean {
  return left.id === right.id && left.contentHash === right.contentHash;
}

export type PreferenceEvidenceAuthority = z.infer<
  typeof PreferenceEvidenceAuthoritySchema
>;
export type PreferenceDatasetRelease = z.infer<
  typeof PreferenceDatasetReleaseSchema
>;
export type RewardModelQualificationKind = z.infer<
  typeof RewardModelQualificationKindSchema
>;
export type RewardModelQualificationReport = z.infer<
  typeof RewardModelQualificationReportSchema
>;
