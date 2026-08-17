import { z } from "zod";

import {
  contentHash,
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "./common.js";
import {
  HarnessReviewEvidenceRefSchema,
  HarnessReviewOwnerScopeSchema,
} from "./evaluation-review.js";
import {
  HarnessRefinerCapabilitiesSchema,
  HarnessRefinerEvidenceBasisSchema,
} from "./refiner.js";
import { HarnessImprovementRouteSchema } from "./harness-workspaces.js";

const ShortTextSchema = z.string().trim().min(1).max(2_000);
const BoundedTextSchema = z.string().trim().min(1).max(100_000);
const HarnessRefinerOperationSchema = z.enum(["create", "update", "delete"]);
const HarnessRefinerInternalRouteSchema = z.enum([
  "memory",
  "prompt",
  "skill",
  "agent",
]);
const HarnessRefinerExternalRouteSchema = z.enum([
  "runtime",
  "product",
  "taskset",
  "training",
]);

export const HarnessRefinerActivityResultSchema = z.enum([
  "no_action",
  "routed",
  "applied",
  "retained",
  "failed",
]);

export const HarnessRefinerCritiqueStatusSchema = z.enum([
  "not_applicable",
  "pending",
  "passed",
  "rejected",
  "failed",
]);

export const HarnessRefinerValidationStatusSchema = z.enum([
  "not_applicable",
  "pending",
  "passed",
  "failed",
]);

export const HarnessRefinerActivityReceiptContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRefinerActivityReceipt.v1"),
    id: ReleaseIdSchema,
    runRef: ReleaseIdSchema,
    turnId: ReleaseIdSchema,
    result: HarnessRefinerActivityResultSchema,
    decision: z.enum(["no_action", "route", "propose"]).nullable(),
    route: HarnessImprovementRouteSchema.nullable(),
    operation: HarnessRefinerOperationSchema.nullable(),
    target: z.string().trim().min(1).max(2_000).nullable(),
    summary: ShortTextSchema,
    evidenceBasis: HarnessRefinerEvidenceBasisSchema.nullable(),
    critiqueStatus: HarnessRefinerCritiqueStatusSchema,
    validationStatus: HarnessRefinerValidationStatusSchema,
    trigger: ImmutableReleaseRefSchema,
    outcome: ImmutableReleaseRefSchema.nullable(),
    proposal: ImmutableReleaseRefSchema.nullable(),
    applyReceipt: ImmutableReleaseRefSchema.nullable(),
    inputHarness: ImmutableReleaseRefSchema,
    outputHarness: ImmutableReleaseRefSchema.nullable(),
    createdAt: ReleaseTimestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const proposalResult = receipt.result === "applied" || receipt.result === "retained";
    if (receipt.result === "no_action") {
      requireFields(context, receipt, {
        decision: "no_action",
        route: null,
        operation: null,
        target: null,
        evidenceBasis: null,
        proposal: null,
        applyReceipt: null,
        outputHarness: null,
        critiqueStatus: "not_applicable",
        validationStatus: "not_applicable",
      });
    } else if (receipt.result === "routed") {
      if (
        receipt.decision !== "route" ||
        !HarnessRefinerExternalRouteSchema.safeParse(receipt.route).success ||
        receipt.operation !== null ||
        receipt.target !== null ||
        receipt.evidenceBasis === null ||
        receipt.proposal !== null ||
        receipt.applyReceipt !== null ||
        receipt.outputHarness !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "routed activity requires an external route and evidence basis without proposal state",
        });
      }
      requireFields(context, receipt, {
        critiqueStatus: "not_applicable",
        validationStatus: "not_applicable",
      });
    } else if (proposalResult) {
      if (
        receipt.decision !== "propose" ||
        !HarnessRefinerInternalRouteSchema.safeParse(receipt.route).success ||
        receipt.operation === null ||
        receipt.target === null ||
        receipt.evidenceBasis === null ||
        receipt.proposal === null ||
        receipt.applyReceipt === null
      ) {
        context.addIssue({
          code: "custom",
          message: "applied and retained activity requires complete proposal state",
        });
      }
      if (receipt.result === "applied" && receipt.outputHarness === null) {
        context.addIssue({
          code: "custom",
          message: "applied activity requires the advanced Harness release",
          path: ["outputHarness"],
        });
      }
      if (
        receipt.result === "applied" &&
        (receipt.critiqueStatus !== "passed" ||
          receipt.validationStatus !== "passed")
      ) {
        context.addIssue({
          code: "custom",
          message: "applied activity requires passed critique and validation",
        });
      }
      if (receipt.result === "retained" && receipt.outputHarness !== null) {
        context.addIssue({
          code: "custom",
          message: "retained activity cannot report a new Harness release",
          path: ["outputHarness"],
        });
      }
    } else if (
      receipt.decision !== null ||
      receipt.route !== null ||
      receipt.operation !== null ||
      receipt.target !== null ||
      receipt.evidenceBasis !== null ||
      receipt.outcome !== null ||
      receipt.proposal !== null ||
      receipt.applyReceipt !== null ||
      receipt.outputHarness !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "failed activity cannot claim a decision, route, proposal, or release transition",
      });
    }
    if (receipt.result !== "failed" && receipt.outcome === null) {
      context.addIssue({
        code: "custom",
        message: "terminal Refiner decisions require an outcome reference",
        path: ["outcome"],
      });
    }
  });

export const HarnessRefinerActivityReceiptSchema =
  HarnessRefinerActivityReceiptContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const HarnessRefinementCandidateStatusSchema = z.enum([
  "unresolved",
  "confirmed",
  "resolved",
  "rejected",
  "expired",
]);

export const HarnessRefinementCandidateResolutionSchema = z
  .object({
    kind: z.enum([
      "applied_change",
      "later_success",
      "manual_rejection",
      "source_revoked",
      "expired",
    ]),
    reason: BoundedTextSchema,
    evidenceRefs: z.array(ImmutableReleaseRefSchema).max(1_000),
    resolvedAt: ReleaseTimestampSchema,
  })
  .strict();

export const HarnessRefinementCandidateContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessRefinementCandidate.v1"),
    id: ReleaseIdSchema,
    ownerScope: HarnessReviewOwnerScopeSchema,
    workspaceRef: ReleaseIdSchema,
    fingerprint: ReleaseHashSchema,
    recurrenceFamily: z.string().trim().min(1).max(1_000),
    statement: BoundedTextSchema,
    status: HarnessRefinementCandidateStatusSchema,
    occurrences: z.array(HarnessReviewEvidenceRefSchema).max(1_000),
    counterevidence: z.array(HarnessReviewEvidenceRefSchema).max(1_000),
    sourceReviews: z.array(ImmutableReleaseRefSchema).min(1).max(100),
    relatedHarnessReleases: z.array(ImmutableReleaseRefSchema).max(100),
    firstSeenAt: ReleaseTimestampSchema,
    lastSeenAt: ReleaseTimestampSchema,
    lastReviewedAt: ReleaseTimestampSchema,
    expiresAt: ReleaseTimestampSchema,
    resolution: HarnessRefinementCandidateResolutionSchema.nullable(),
    createdAt: ReleaseTimestampSchema,
    updatedAt: ReleaseTimestampSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    requireUniqueRefs(context, candidate.occurrences, "occurrences");
    requireUniqueRefs(context, candidate.counterevidence, "counterevidence");
    requireUniqueRefs(context, candidate.sourceReviews, "sourceReviews");
    requireUniqueRefs(
      context,
      candidate.relatedHarnessReleases,
      "relatedHarnessReleases",
    );
    const supportingKeys = new Set(
      candidate.occurrences.map((item) => item.occurrenceKey),
    );
    if (
      candidate.counterevidence.some((item) => supportingKeys.has(item.occurrenceKey))
    ) {
      context.addIssue({
        code: "custom",
        message: "supporting occurrences and counterevidence must be disjoint",
        path: ["counterevidence"],
      });
    }
    const actionable = candidate.status === "unresolved" || candidate.status === "confirmed";
    if (actionable && candidate.occurrences.length === 0) {
      context.addIssue({
        code: "custom",
        message: "actionable candidates require at least one supporting occurrence",
        path: ["occurrences"],
      });
    }
    if (
      actionable &&
      [...candidate.occurrences, ...candidate.counterevidence].some(
        (item) => item.sourcePolicy.state !== "authorized",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "actionable candidates may contain only currently authorized evidence",
        path: ["occurrences"],
      });
    }
    if (actionable !== (candidate.resolution === null)) {
      context.addIssue({
        code: "custom",
        message: "only resolved, rejected, or expired candidates require a resolution",
        path: ["resolution"],
      });
    }
    if (
      candidate.status === "expired" &&
      candidate.resolution?.kind !== "expired"
    ) {
      context.addIssue({
        code: "custom",
        message: "expired candidates require an expired resolution",
        path: ["resolution", "kind"],
      });
    }
    if (
      candidate.status === "rejected" &&
      candidate.resolution &&
      !["manual_rejection", "source_revoked"].includes(candidate.resolution.kind)
    ) {
      context.addIssue({
        code: "custom",
        message: "rejected candidates require a rejection or revocation resolution",
        path: ["resolution", "kind"],
      });
    }
    if (
      candidate.status === "resolved" &&
      candidate.resolution &&
      !["applied_change", "later_success"].includes(candidate.resolution.kind)
    ) {
      context.addIssue({
        code: "custom",
        message: "resolved candidates require applied-change or later-success evidence",
        path: ["resolution", "kind"],
      });
    }
    requireChronology(context, candidate);
  });

export const HarnessRefinementCandidateSchema =
  HarnessRefinementCandidateContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const HarnessRefinementCandidateLifecycleDecisionSchema = z.enum([
  "created",
  "merged",
  "rejected",
  "expired",
  "reopened",
  "resolved",
]);

export const HarnessRefinementCandidateLifecycleReceiptContentSchema = z
  .object({
    schemaVersion: z.literal(
      "openpond.harnessRefinementCandidateLifecycleReceipt.v1",
    ),
    id: ReleaseIdSchema,
    candidateId: ReleaseIdSchema,
    decision: HarnessRefinementCandidateLifecycleDecisionSchema,
    beforeCandidate: ImmutableReleaseRefSchema.nullable(),
    afterCandidate: ImmutableReleaseRefSchema,
    review: ImmutableReleaseRefSchema,
    addedEvidence: z.array(HarnessReviewEvidenceRefSchema).max(1_000),
    removedEvidence: z.array(ImmutableReleaseRefSchema).max(1_000),
    reason: BoundedTextSchema,
    createdAt: ReleaseTimestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if ((receipt.decision === "created") !== (receipt.beforeCandidate === null)) {
      context.addIssue({
        code: "custom",
        message: "only candidate creation omits the previous candidate reference",
        path: ["beforeCandidate"],
      });
    }
    if (
      receipt.beforeCandidate &&
      receipt.beforeCandidate.contentHash === receipt.afterCandidate.contentHash
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate lifecycle transitions must change candidate content",
        path: ["afterCandidate"],
      });
    }
    if (
      ["created", "reopened"].includes(receipt.decision) &&
      receipt.addedEvidence.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${receipt.decision} candidate transitions require added evidence`,
        path: ["addedEvidence"],
      });
    }
    if (
      receipt.addedEvidence.some(
        (item) => item.sourcePolicy.state !== "authorized",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate transitions may add only authorized evidence",
        path: ["addedEvidence"],
      });
    }
    requireUniqueRefs(context, receipt.addedEvidence, "addedEvidence");
    requireUniqueRefs(context, receipt.removedEvidence, "removedEvidence");
    const removedKeys = new Set(receipt.removedEvidence.map((item) => refKey(item)));
    if (receipt.addedEvidence.some((item) => removedKeys.has(refKey(item.evidence)))) {
      context.addIssue({
        code: "custom",
        message: "candidate lifecycle evidence cannot be added and removed together",
        path: ["removedEvidence"],
      });
    }
  });

export const HarnessRefinementCandidateLifecycleReceiptSchema =
  HarnessRefinementCandidateLifecycleReceiptContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export const HarnessCrossRunRefinementRequestContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessCrossRunRefinementRequest.v1"),
    id: ReleaseIdSchema,
    ownerScope: HarnessReviewOwnerScopeSchema,
    workspaceRef: ReleaseIdSchema,
    candidate: ImmutableReleaseRefSchema,
    candidateFingerprint: ReleaseHashSchema,
    review: ImmutableReleaseRefSchema,
    admittedHarness: ImmutableReleaseRefSchema,
    evidence: z.array(HarnessReviewEvidenceRefSchema).min(1).max(1_000),
    capabilities: HarnessRefinerCapabilitiesSchema,
    deduplicationKey: ReleaseHashSchema,
    createdAt: ReleaseTimestampSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.evidence.some((item) => item.sourcePolicy.state !== "authorized")) {
      context.addIssue({
        code: "custom",
        message: "cross-run refinement requires currently authorized evidence",
        path: ["evidence"],
      });
    }
    requireUniqueRefs(context, request.evidence, "evidence");
    if (!Object.values(request.capabilities).some(Boolean)) {
      context.addIssue({
        code: "custom",
        message: "cross-run refinement requires at least one available Harness capability",
        path: ["capabilities"],
      });
    }
    const expected = harnessCrossRunRefinementDeduplicationKey(request);
    if (request.deduplicationKey !== expected) {
      context.addIssue({
        code: "custom",
        message: `cross-run refinement deduplicationKey is ${request.deduplicationKey}; expected ${expected}`,
        path: ["deduplicationKey"],
      });
    }
  });

export const HarnessCrossRunRefinementRequestSchema =
  HarnessCrossRunRefinementRequestContentSchema.extend({
    contentHash: ReleaseHashSchema,
  }).strict();

export function createHarnessRefinerActivityReceipt(
  input: z.input<typeof HarnessRefinerActivityReceiptContentSchema>,
): HarnessRefinerActivityReceipt {
  return createHashedContract(
    input,
    HarnessRefinerActivityReceiptContentSchema,
    HarnessRefinerActivityReceiptSchema,
  );
}

export function verifyHarnessRefinerActivityReceipt(
  value: unknown,
): value is HarnessRefinerActivityReceipt {
  return verifyHashedContract(
    value,
    HarnessRefinerActivityReceiptContentSchema,
    HarnessRefinerActivityReceiptSchema,
  );
}

export function createHarnessRefinementCandidate(
  input: z.input<typeof HarnessRefinementCandidateContentSchema>,
): HarnessRefinementCandidate {
  return createHashedContract(
    input,
    HarnessRefinementCandidateContentSchema,
    HarnessRefinementCandidateSchema,
  );
}

export function verifyHarnessRefinementCandidate(
  value: unknown,
): value is HarnessRefinementCandidate {
  return verifyHashedContract(
    value,
    HarnessRefinementCandidateContentSchema,
    HarnessRefinementCandidateSchema,
  );
}

export function createHarnessRefinementCandidateLifecycleReceipt(
  input: z.input<typeof HarnessRefinementCandidateLifecycleReceiptContentSchema>,
): HarnessRefinementCandidateLifecycleReceipt {
  return createHashedContract(
    input,
    HarnessRefinementCandidateLifecycleReceiptContentSchema,
    HarnessRefinementCandidateLifecycleReceiptSchema,
  );
}

export function verifyHarnessRefinementCandidateLifecycleReceipt(
  value: unknown,
): value is HarnessRefinementCandidateLifecycleReceipt {
  return verifyHashedContract(
    value,
    HarnessRefinementCandidateLifecycleReceiptContentSchema,
    HarnessRefinementCandidateLifecycleReceiptSchema,
  );
}

export function harnessCrossRunRefinementDeduplicationKey(input: {
  workspaceRef: string;
  candidateFingerprint: string;
  admittedHarness: { id: string; contentHash: string };
}): string {
  return contentHash({
    schemaVersion: "openpond.harnessCrossRunRefinementIdentity.v1",
    workspaceRef: input.workspaceRef,
    candidateFingerprint: input.candidateFingerprint,
    admittedHarness: input.admittedHarness,
  });
}

export function createHarnessCrossRunRefinementRequest(
  input: z.input<typeof HarnessCrossRunRefinementRequestContentSchema>,
): HarnessCrossRunRefinementRequest {
  return createHashedContract(
    input,
    HarnessCrossRunRefinementRequestContentSchema,
    HarnessCrossRunRefinementRequestSchema,
  );
}

export function verifyHarnessCrossRunRefinementRequest(
  value: unknown,
): value is HarnessCrossRunRefinementRequest {
  return verifyHashedContract(
    value,
    HarnessCrossRunRefinementRequestContentSchema,
    HarnessCrossRunRefinementRequestSchema,
  );
}

function createHashedContract<TContent, TResult>(
  input: unknown,
  contentSchema: z.ZodType<TContent>,
  resultSchema: z.ZodType<TResult>,
): TResult {
  const content = contentSchema.parse(input);
  return resultSchema.parse({
    ...(content as Record<string, unknown>),
    contentHash: contentHash(content),
  });
}

function verifyHashedContract<TContent, TResult extends { contentHash: string }>(
  value: unknown,
  contentSchema: z.ZodType<TContent>,
  resultSchema: z.ZodType<TResult>,
): value is TResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return contentHash(contentSchema.parse(content)) === actual;
}

function requireFields(
  context: z.RefinementCtx,
  value: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] === expectedValue) continue;
    context.addIssue({
      code: "custom",
      message: `${key} must be ${String(expectedValue)}`,
      path: [key],
    });
  }
}

function requireUniqueRefs(
  context: z.RefinementCtx,
  values: readonly unknown[],
  path: string,
): void {
  const keys = values.map((value) => refKey(value));
  if (new Set(keys).size === keys.length) return;
  context.addIssue({
    code: "custom",
    message: `${path} references must be unique`,
    path: [path],
  });
}

function refKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.occurrenceKey === "string") return record.occurrenceKey;
  const nested = record.evidence;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const evidence = nested as Record<string, unknown>;
    return `${String(evidence.id)}:${String(evidence.contentHash)}`;
  }
  return `${String(record.id)}:${String(record.contentHash)}`;
}

function requireChronology(
  context: z.RefinementCtx,
  candidate: z.infer<typeof HarnessRefinementCandidateContentSchema>,
): void {
  const chronology = [
    ["firstSeenAt", candidate.firstSeenAt],
    ["lastSeenAt", candidate.lastSeenAt],
    ["lastReviewedAt", candidate.lastReviewedAt],
    ["updatedAt", candidate.updatedAt],
    ["expiresAt", candidate.expiresAt],
  ] as const;
  for (let index = 1; index < chronology.length; index += 1) {
    const previous = chronology[index - 1]!;
    const current = chronology[index]!;
    if (Date.parse(previous[1]) <= Date.parse(current[1])) continue;
    context.addIssue({
      code: "custom",
      message: `${current[0]} must not precede ${previous[0]}`,
      path: [current[0]],
    });
  }
  if (Date.parse(candidate.createdAt) > Date.parse(candidate.updatedAt)) {
    context.addIssue({
      code: "custom",
      message: "updatedAt must not precede createdAt",
      path: ["updatedAt"],
    });
  }
}

export type HarnessRefinerActivityResult = z.infer<
  typeof HarnessRefinerActivityResultSchema
>;
export type HarnessRefinerActivityReceipt = z.infer<
  typeof HarnessRefinerActivityReceiptSchema
>;
export type HarnessRefinementCandidateStatus = z.infer<
  typeof HarnessRefinementCandidateStatusSchema
>;
export type HarnessRefinementCandidate = z.infer<
  typeof HarnessRefinementCandidateSchema
>;
export type HarnessRefinementCandidateLifecycleDecision = z.infer<
  typeof HarnessRefinementCandidateLifecycleDecisionSchema
>;
export type HarnessRefinementCandidateLifecycleReceipt = z.infer<
  typeof HarnessRefinementCandidateLifecycleReceiptSchema
>;
export type HarnessCrossRunRefinementRequest = z.infer<
  typeof HarnessCrossRunRefinementRequestSchema
>;
