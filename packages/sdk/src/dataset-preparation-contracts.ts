import { z } from "zod";
import { ConnectedCaseRefSchema } from "./connected-evidence-contracts.js";
import { TasksetCatalogReleaseRefSchema } from "./taskset-catalog.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime();
const Count = z.number().int().nonnegative();
const MicroUsd = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const DatasetPreparationGrantCreateSchema = z
  .object({
    id: Id,
    projectId: Id,
    maximumMicroUsd: MicroUsd.positive(),
    maximumSandboxSeconds: Count.max(10_800),
  })
  .strict();

export const DatasetPreparationGrantSchema = z
  .object({
    schemaVersion: z.literal("openpond.datasetPreparationGrant.v1"),
    id: Id,
    teamId: Id,
    ownerUserId: Id,
    projectId: Id,
    maximumMicroUsd: MicroUsd,
    maximumSandboxSeconds: Count,
    settledMicroUsd: MicroUsd,
    heldMicroUsd: MicroUsd,
    sandboxSeconds: Count,
    heldSandboxSeconds: Count,
    unresolvedCalls: Count,
    cleanupPending: Count,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();

export const DatasetPreparationTaskClassSchema = z.enum([
  "coding_change",
  "debugging",
  "code_explanation",
  "structured_text",
  "artifact_work",
]);
export const DatasetPreparationStageSchema = z.enum([
  "inventory",
  "preview",
  "reconstruction",
  "grader_authoring",
  "qualification",
  "release",
]);
export const DatasetPreparationStatusSchema = z.enum([
  "draft",
  "running",
  "pausing",
  "paused",
  "needs_attention",
  "preview_ready",
  "ready",
  "releasing",
  "completed",
  "insufficient_data",
  "budget_exhausted",
  "cancelling",
  "cancelled",
  "failed",
]);

export const DatasetPreparationSourceSchema = z
  .object({
    projectId: Id,
    from: Timestamp,
    to: Timestamp,
    importCutoff: Timestamp,
    connections: z.array(Id).min(1).max(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.from) >= Date.parse(value.to))
      ctx.addIssue({
        code: "custom",
        message: "Source event-time window must be nonempty.",
      });
    if (new Set(value.connections).size !== value.connections.length)
      ctx.addIssue({
        code: "custom",
        message: "Source connections must be unique.",
      });
  });

export const DatasetPreparationPolicySchema = z
  .object({
    source: DatasetPreparationSourceSchema,
    taskClasses: z.array(DatasetPreparationTaskClassSchema).min(1).max(5),
    limits: z
      .object({
        maximumConversations: z.number().int().min(1).max(10_000),
        maximumCandidates: z.number().int().min(1).max(10_000),
        acceptedTarget: z.number().int().min(1).max(10_000),
        maximumRepairsPerCandidate: z.number().int().min(0).max(5),
        maximumEvidenceBytesPerConversation: z
          .number()
          .int()
          .min(1_024)
          .max(2_000_000),
      })
      .strict(),
    researcher: z
      .object({
        modelId: Id,
        maximumOutputTokens: z.number().int().min(1).max(32_768),
      })
      .strict(),
    grading: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("auto") }).strict(),
      z.object({ mode: z.literal("existing_only") }).strict(),
      z
        .object({
          mode: z.literal("manual"),
          releases: z.array(TasksetCatalogReleaseRefSchema).min(1).max(100),
        })
        .strict(),
    ]),
    budget: z
      .object({
        grantId: Id,
        maximumMicroUsd: MicroUsd.positive(),
        previewMaximumMicroUsd: MicroUsd,
        qualificationMaximumMicroUsdPerCandidate: MicroUsd,
        maximumSandboxSeconds: Count.max(10_800),
      })
      .strict(),
    finish: z.enum(["stop_ready", "create_private_version"]),
    execution: z.enum(["preview_only", "prepare"]),
    allowPartialVersion: z.boolean(),
    // Pilot-inspected material is development data. Protected study preparation
    // uses a separate authorization and cannot inherit this inspection policy.
    population: z.literal("development"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.limits.acceptedTarget > value.limits.maximumCandidates)
      ctx.addIssue({
        code: "custom",
        message: "Accepted target exceeds candidate scan limit.",
      });
    if (value.budget.previewMaximumMicroUsd > value.budget.maximumMicroUsd)
      ctx.addIssue({
        code: "custom",
        message: "Preview allowance exceeds the shared preparation ceiling.",
      });
    if (new Set(value.taskClasses).size !== value.taskClasses.length)
      ctx.addIssue({ code: "custom", message: "Task classes must be unique." });
  });

export const DatasetPreparationCreateSchema = z
  .object({
    operationId: Id,
    expectedDatasetRevision: z.number().int().positive(),
    policy: DatasetPreparationPolicySchema,
  })
  .strict();

export const DatasetPreparationCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.enum(["start", "pause", "resume", "cancel", "release"]),
      operationId: Id,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve"),
      operationId: Id,
      expectedRevision: z.number().int().positive(),
      candidateId: Id,
      decision: z.enum(["retry", "exclude"]),
      reason: z.string().trim().min(1).max(5_000),
    })
    .strict(),
]);

export const DatasetPreparationCoverageSchema = z
  .object({
    conversations: Count,
    importedTurns: Count,
    selectedTurns: Count,
    queuedSnapshots: Count.nullable(),
    failedSessions: Count.nullable(),
    skippedSessions: Count.nullable(),
    lastAdmissionAt: Timestamp.nullable(),
    complete: z.boolean(),
    reasons: z
      .array(
        z
          .object({ code: Id, message: z.string().trim().min(1).max(2_000) })
          .strict(),
      )
      .max(100),
    sourceInventoryHash: Hash,
  })
  .strict();

export const DatasetPreparationAccountingSchema = z
  .object({
    maximumMicroUsd: MicroUsd,
    settledMicroUsd: MicroUsd,
    heldMicroUsd: MicroUsd,
    unresolvedCalls: Count,
    sandboxSeconds: Count,
    cleanupPending: Count,
    complete: z.boolean(),
  })
  .strict();

export const DatasetPreparationPreviewSchema = z
  .object({
    sampleConversations: Count,
    sampleTurns: Count,
    candidateCount: Count,
    modelId: Id,
    modelConfigurationHash: Hash,
    callReceiptIds: z.array(Id).max(2_000),
    inputTokens: Count.nullable(),
    outputTokens: Count.nullable(),
    classes: z
      .array(
        z
          .object({
            taskClass: DatasetPreparationTaskClassSchema,
            candidates: Count,
            assessment: z.enum([
              "executable",
              "calibrated_judge",
              "unsupported",
            ]),
            requirements: z.array(z.string().trim().min(1).max(5_000)).max(20),
          })
          .strict(),
      )
      .max(5),
    exclusions: z
      .array(
        z
          .object({
            code: Id,
            count: Count,
            reason: z.string().trim().min(1).max(5_000),
          })
          .strict(),
      )
      .max(100),
    estimates: z
      .array(
        z
          .object({
            stage: DatasetPreparationStageSchema,
            minimumMicroUsd: MicroUsd,
            maximumMicroUsd: MicroUsd,
            assumptions: z
              .array(z.string().trim().min(1).max(2_000))
              .min(1)
              .max(20),
          })
          .strict()
          .refine(
            (value) => value.minimumMicroUsd <= value.maximumMicroUsd,
            "Estimate range is reversed.",
          ),
      )
      .max(6),
    createdAt: Timestamp,
  })
  .strict();

export const DatasetPreparationRunSchema = z
  .object({
    schemaVersion: z.literal("openpond.datasetPreparationRun.v1"),
    id: Id,
    operationId: Id,
    teamId: Id,
    ownerUserId: Id,
    datasetId: Id,
    datasetRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    requestHash: Hash,
    policy: DatasetPreparationPolicySchema,
    status: DatasetPreparationStatusSchema,
    stage: DatasetPreparationStageSchema,
    coverage: DatasetPreparationCoverageSchema.nullable(),
    preview: DatasetPreparationPreviewSchema.nullable(),
    counts: z
      .object({
        scannedConversations: Count,
        scannedTurns: Count,
        candidates: Count,
        reconstructed: Count,
        qualifying: Count,
        qualified: Count,
        excluded: Count,
        needsAttention: Count,
      })
      .strict(),
    accounting: DatasetPreparationAccountingSchema,
    publication: z
      .object({
        datasetId: Id,
        workspaceRevision: z.number().int().positive(),
        release: TasksetCatalogReleaseRefSchema,
      })
      .strict()
      .nullable(),
    error: z
      .object({ code: Id, message: z.string().trim().min(1).max(5_000) })
      .strict()
      .nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.accounting.maximumMicroUsd !== value.policy.budget.maximumMicroUsd
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Accounting authority differs from the saved preparation policy.",
      });
    if (
      value.counts.qualified +
        value.counts.excluded +
        value.counts.needsAttention >
      value.counts.candidates
    )
      ctx.addIssue({
        code: "custom",
        message: "Preparation outcomes exceed the candidate population.",
      });
    if (
      value.status === "preview_ready" &&
      (value.policy.execution !== "preview_only" || value.stage !== "preview" || !value.preview || !value.coverage?.complete || !value.accounting.complete)
    ) ctx.addIssue({ code: "custom", message: "Preview readiness requires a preview-only policy, reconciled source coverage and settled preview calls." });
    if (
      ["ready", "releasing", "completed"].includes(value.status) &&
      (value.counts.qualified === 0 || !value.policy.allowPartialVersion &&
      value.counts.qualified < value.policy.limits.acceptedTarget)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Preparation cannot report readiness below its accepted target.",
      });
    if (["ready", "releasing", "completed"].includes(value.status) &&
      (value.policy.execution !== "prepare" || !value.preview || !value.coverage?.complete || !value.accounting.complete))
      ctx.addIssue({ code: "custom", message: "Dataset readiness requires full preparation authority, reconciled source coverage, preview and final accounting." });
    if (
      value.status === "completed" &&
      (!value.publication || !value.accounting.complete)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Completed preparation requires publication and reconciled accounting.",
      });
    if (
      value.status === "cancelled" &&
      (!value.accounting.complete || value.accounting.cleanupPending > 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Cancellation requires settled resource obligations.",
      });
  });

export const DatasetPreparationListSchema = z
  .object({
    teamId: Id,
    datasetId: Id,
    runs: z.array(DatasetPreparationRunSchema).max(50),
    nextCursor: Id.nullable(),
  })
  .strict();

/** References only. Evidence bytes are read by authorized owners, never from
 * caller-supplied spans or a policy-visible task package. */
export const PreparedTaskEvidenceSpanSchema = z
  .object({
    source: ConnectedCaseRefSchema,
    startSequence: Count,
    endSequence: Count,
    role: z.enum([
      "requirement",
      "initial_context",
      "outcome",
      "correction",
      "verification",
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endSequence < value.startSequence)
      ctx.addIssue({
        code: "custom",
        message: "Evidence span must be ordered.",
      });
  });

export const PreparedTaskProvenanceSchema = z
  .object({
    schemaVersion: z.literal("openpond.preparedTaskProvenance.v1"),
    candidateId: Id,
    preparationId: Id,
    familyKey: Id,
    sourceSpans: z.array(PreparedTaskEvidenceSpanSchema).min(1).max(200),
    firstAvailableAt: Timestamp,
    initialInputHash: Hash,
    initialEnvironmentHash: Hash,
    sourceScopeHash: Hash,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.sourceSpans.some((span) => span.role === "requirement"))
      ctx.addIssue({
        code: "custom",
        message: "A reconstructed task needs a source requirement.",
      });
  const seen = new Set<string>();
  for (const span of value.sourceSpans) {
    if (value.sourceSpans.some(other => other !== span && other.source.id === span.source.id
      && other.source.snapshotHash === span.source.snapshotHash && other.role !== span.role
      && span.startSequence <= other.endSequence && other.startSequence <= span.endSequence))
      ctx.addIssue({ code: "custom", message: "Evidence offsets cannot have conflicting roles." });
      const key = JSON.stringify([
        span.source,
        span.startSequence,
        span.endSequence,
      ]);
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          message:
            "Evidence span is duplicated or crosses public/private roles.",
        });
      seen.add(key);
    }
  });

export const PreparedTaskQualificationSchema = z
  .object({
    schemaVersion: z.literal("openpond.preparedTaskQualification.v1"),
    id: Id,
    candidateId: Id,
    preparationId: Id,
    taskHash: Hash,
    environmentHash: Hash,
    packageHash: Hash,
    graderBindings: z
      .array(
        z
          .object({
            id: Id,
            version: Id,
            contentHash: Hash,
            origin: z.enum(["reused", "adapted", "authored"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    checks: z
      .array(
        z
          .object({
            id: Id,
            label: z.enum([
              "positive",
              "incorrect",
              "incomplete",
              "adversarial",
              "clean_reset",
            ]),
            executionReceiptId: Id,
            expectedPassed: z.boolean(),
            observedPassed: z.boolean().nullable(),
            infrastructureError: Id.nullable(),
          })
          .strict(),
      )
      .min(5)
      .max(500),
    independentEvidenceRefs: z.array(Id).min(1).max(100),
    judgeCalibration: z.enum(["not_applicable", "passed", "failed", "pending"]),
    cleanup: z.enum(["completed", "pending"]),
    passed: z.boolean(),
    createdAt: Timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.passed) return;
    const labels = new Set(value.checks.map((check) => check.label));
    if (
      [
        "positive",
        "incorrect",
        "incomplete",
        "adversarial",
        "clean_reset",
      ].some(
        (label) => !labels.has(label as (typeof value.checks)[number]["label"]),
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Qualified tasks require positive, negative, adversarial and clean-reset evidence.",
      });
    if (
      value.cleanup !== "completed" ||
      ["pending", "failed"].includes(value.judgeCalibration) ||
      value.checks.some(
        (check) =>
          check.infrastructureError !== null ||
          check.observedPassed !== check.expectedPassed,
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Failed, uncalibrated or uncleared checks cannot qualify a task.",
      });
    if (
      value.checks.some(
        (check) =>
          check.expectedPassed !==
          ["positive", "clean_reset"].includes(check.label),
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Qualification witnesses must pass positives/resets and reject incorrect, incomplete and adversarial outputs.",
      });
  });

export const DatasetPreparationCandidateSchema = z
  .object({
    id: Id,
    runId: Id,
    revision: z.number().int().positive(),
    taskClass: DatasetPreparationTaskClassSchema,
    status: z.enum([
      "discovered",
      "reconstructing",
      "authoring",
      "qualifying",
      "qualified",
      "excluded",
      "needs_attention",
    ]),
    objective: z.string().trim().min(1).max(20_000),
    provenance: PreparedTaskProvenanceSchema.nullable(),
    qualification: PreparedTaskQualificationSchema.nullable(),
    reason: z
      .object({ code: Id, message: z.string().trim().min(1).max(5_000) })
      .strict()
      .nullable(),
    attempts: Count.max(6),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === "qualified" &&
      (!value.provenance || !value.qualification?.passed)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Candidate admission requires reconstruction and qualification receipts.",
      });
    if (
      value.provenance &&
      (value.provenance.candidateId !== value.id ||
        value.provenance.preparationId !== value.runId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Candidate provenance identity mismatch.",
      });
    if (
      value.qualification &&
      (value.qualification.candidateId !== value.id ||
        value.qualification.preparationId !== value.runId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Candidate qualification identity mismatch.",
      });
  });

export type DatasetPreparationPolicy = z.infer<
  typeof DatasetPreparationPolicySchema
>;
export type DatasetPreparationGrant = z.infer<
  typeof DatasetPreparationGrantSchema
>;
export type DatasetPreparationRun = z.infer<typeof DatasetPreparationRunSchema>;
export type DatasetPreparationCandidate = z.infer<
  typeof DatasetPreparationCandidateSchema
>;
export type PreparedTaskProvenance = z.infer<
  typeof PreparedTaskProvenanceSchema
>;
export type PreparedTaskQualification = z.infer<
  typeof PreparedTaskQualificationSchema
>;
