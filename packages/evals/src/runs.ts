import { z } from "zod";

import {
  FailureClassSchema,
  ImmutableArtifactRefSchema,
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ModelRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  assertContentHash,
  contentHash,
} from "@openpond/harness";

export const RuntimeTargetBindingSchema = z.object({
  adapterId: ReleaseIdSchema,
  placement: z.enum(["local", "remote", "colocated", "provider_native"]),
  runtimeVersion: z.string().trim().min(1).max(200),
  capabilityReceipt: ReleaseHashSchema,
}).strict();

export const RunLimitsSchema = z.object({
  maxTurns: z.number().int().positive().max(100_000),
  timeoutMs: z.number().int().positive().max(86_400_000),
  maxOutputBytes: z.number().int().positive().max(250_000_000),
  maximumSpendUsd: z.number().nonnegative().nullable(),
}).strict();

export const RunManifestContentSchema = z.object({
  schemaVersion: z.literal("openpond.runManifest.v1"),
  id: ReleaseIdSchema,
  harnessRelease: ImmutableReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  model: ModelRefSchema,
  runtimeTarget: RuntimeTargetBindingSchema,
  limits: RunLimitsSchema,
  approval: z.object({ id: ReleaseIdSchema, contentHash: ReleaseHashSchema }).strict().nullable(),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict();
export const RunManifestSchema = RunManifestContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export const AttemptReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.attemptReceipt.v1"),
  id: ReleaseIdSchema,
  runManifest: ImmutableReleaseRefSchema,
  taskId: ReleaseIdSchema,
  seed: z.string().trim().min(1).max(500),
  terminal: z.boolean(),
  failureClass: FailureClassSchema.nullable(),
  outputHash: ReleaseHashSchema.nullable(),
  traceHash: ReleaseHashSchema,
  artifactRefs: z.array(ImmutableArtifactRefSchema).max(100_000),
  graderEvidenceRefs: z.array(ImmutableArtifactRefSchema).max(10_000),
  startedAt: ReleaseTimestampSchema,
  completedAt: ReleaseTimestampSchema,
  latencyMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  legacyAttemptRef: ReleaseIdSchema.nullable().default(null),
  metadata: MetadataSchema,
}).strict();
export const AttemptReceiptSchema = AttemptReceiptContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export const EvaluationResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.evaluationResult.v1"),
  id: ReleaseIdSchema,
  runManifest: ImmutableReleaseRefSchema,
  harnessRelease: ImmutableReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  model: ModelRefSchema,
  receiptRefs: z.array(ImmutableReleaseRefSchema).min(1).max(1_000_000),
  attemptCount: z.number().int().positive(),
  rewardEligibleCount: z.number().int().nonnegative(),
  terminalCount: z.number().int().nonnegative(),
  meanScore: z.number().min(0).max(1).nullable(),
  failureCounts: z.record(FailureClassSchema, z.number().int().nonnegative()),
  metadata: MetadataSchema,
}).strict();
export const EvaluationResultSchema = EvaluationResultContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export const HarnessCompatibilityReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.harnessCompatibility.v1"),
  id: ReleaseIdSchema,
  baseHarnessRelease: ImmutableReleaseRefSchema,
  candidateHarnessRelease: ImmutableReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  environmentHash: ReleaseHashSchema,
  toolContractHash: ReleaseHashSchema,
  policyHash: ReleaseHashSchema,
  graderInterfaceHash: ReleaseHashSchema,
  metadata: MetadataSchema,
}).strict();
export const HarnessCompatibilityReceiptSchema = HarnessCompatibilityReceiptContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

export function createRunManifest(input: z.input<typeof RunManifestContentSchema>): RunManifest {
  const content = RunManifestContentSchema.parse(input);
  return RunManifestSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function createAttemptReceipt(input: z.input<typeof AttemptReceiptContentSchema>): AttemptReceipt {
  const content = AttemptReceiptContentSchema.parse(input);
  return AttemptReceiptSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function verifyAttemptReceipt(receipt: AttemptReceipt): boolean {
  const parsed = AttemptReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data;
  return contentHash(AttemptReceiptContentSchema.parse(content)) === actual;
}

export function aggregateEvaluationReceipts(input: {
  id: string;
  manifest: RunManifest;
  receipts: AttemptReceipt[];
  metadata?: Record<string, unknown>;
}): EvaluationResult {
  if (!input.receipts.length) throw new Error("An evaluation requires at least one attempt receipt.");
  for (const receipt of input.receipts) {
    if (receipt.runManifest.id !== input.manifest.id || receipt.runManifest.contentHash !== input.manifest.contentHash) {
      throw new Error(`Attempt receipt ${receipt.id} belongs to a different Run Manifest.`);
    }
    if (!verifyAttemptReceipt(receipt)) throw new Error(`Attempt receipt ${receipt.id} has an invalid content hash.`);
  }
  const scores = input.receipts.flatMap((receipt) =>
    typeof receipt.metadata.score === "number" && Number.isFinite(receipt.metadata.score)
      ? [receipt.metadata.score]
      : [],
  );
  const failureCounts = Object.fromEntries(
    FailureClassSchema.options.map((failure) => [failure, input.receipts.filter((receipt) => receipt.failureClass === failure).length]),
  );
  const content = EvaluationResultContentSchema.parse({
    schemaVersion: "openpond.evaluationResult.v1",
    id: input.id,
    runManifest: { id: input.manifest.id, contentHash: input.manifest.contentHash },
    harnessRelease: input.manifest.harnessRelease,
    tasksetRelease: input.manifest.tasksetRelease,
    model: input.manifest.model,
    receiptRefs: input.receipts.map((receipt) => ({ id: receipt.id, contentHash: receipt.contentHash })),
    attemptCount: input.receipts.length,
    rewardEligibleCount: input.receipts.filter((receipt) => receipt.metadata.rewardEligible === true && receipt.failureClass !== "infrastructure_failure").length,
    terminalCount: input.receipts.filter((receipt) => receipt.terminal).length,
    meanScore: scores.length ? scores.reduce((total, score) => total + score, 0) / scores.length : null,
    failureCounts,
    metadata: input.metadata ?? {},
  });
  return EvaluationResultSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function createHarnessCompatibilityReceipt(
  input: z.input<typeof HarnessCompatibilityReceiptContentSchema>,
): z.infer<typeof HarnessCompatibilityReceiptSchema> {
  const content = HarnessCompatibilityReceiptContentSchema.parse(input);
  return HarnessCompatibilityReceiptSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function assertComparableRunManifests(
  base: RunManifest,
  candidate: RunManifest,
  compatibility?: z.input<typeof HarnessCompatibilityReceiptSchema>,
): void {
  if (base.tasksetRelease.contentHash !== candidate.tasksetRelease.contentHash) {
    throw new Error("Evaluation runs use different Taskset Releases.");
  }
  if (base.harnessRelease.contentHash === candidate.harnessRelease.contentHash) return;
  if (!compatibility) {
    throw new Error("Evaluation runs use different Harness Releases without a compatibility receipt.");
  }
  const receipt = HarnessCompatibilityReceiptSchema.parse(compatibility);
  assertContentHash(receipt, "Harness compatibility receipt");
  if (
    receipt.baseHarnessRelease.contentHash !== base.harnessRelease.contentHash
    || receipt.candidateHarnessRelease.contentHash !== candidate.harnessRelease.contentHash
    || receipt.tasksetRelease.contentHash !== base.tasksetRelease.contentHash
  ) {
    throw new Error("Harness compatibility receipt does not match the compared runs.");
  }
}

export function rewardEligibleReceipts(receipts: AttemptReceipt[]): AttemptReceipt[] {
  return receipts.filter((receipt) =>
    receipt.terminal
    && receipt.failureClass !== "infrastructure_failure"
    && receipt.failureClass !== "timeout"
    && receipt.failureClass !== "cancelled"
    && receipt.metadata.rewardEligible === true
    && typeof receipt.metadata.score === "number",
  );
}

export type { ModelRef } from "@openpond/harness";
export type RuntimeTargetBinding = z.infer<typeof RuntimeTargetBindingSchema>;
export type RunLimits = z.infer<typeof RunLimitsSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type AttemptReceipt = z.infer<typeof AttemptReceiptSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type HarnessCompatibilityReceipt = z.infer<typeof HarnessCompatibilityReceiptSchema>;
