import { z } from "zod";

import {
  ImmutableArtifactRefSchema,
  ImmutableReleaseRefSchema,
  ModelRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
  contentHash,
  type ImmutableArtifactRef,
} from "@openpond/harness";

export const WORK_EVIDENCE_SCHEMA_VERSION = "openpond.workEvidenceReceipt.v1" as const;
export const WORK_PROCESS_TRACE_SCHEMA_VERSION = "openpond.workProcessTrace.v1" as const;
export const WORK_FEEDBACK_SCHEMA_VERSION = "openpond.workFeedbackReceipt.v1" as const;
export const WORK_EVIDENCE_ELIGIBILITY_SCHEMA_VERSION = "openpond.workEvidenceEligibility.v1" as const;

export const WorkSourceOpaqueRefSchema = z.string().regex(
  /^urn:openpond:work:[a-f0-9]{64}$/,
  "Work source references must be opaque SHA-256 URNs.",
);
export const WorkWorkspaceOpaqueRefSchema = z.string().regex(
  /^urn:openpond:workspace:[a-f0-9]{64}$/,
  "Workspace references must be opaque SHA-256 URNs.",
);
export const EvidenceArtifactIdSchema = z.string().regex(
  /^urn:openpond:artifact:[a-f0-9]{64}$/,
  "Evidence artifacts must use content-addressed SHA-256 URNs.",
);
export const EvidenceArtifactRefSchema = ImmutableArtifactRefSchema.extend({
  id: EvidenceArtifactIdSchema,
}).strict().superRefine((artifact, context) => {
  if (artifact.id !== evidenceArtifactId(artifact.contentHash)) {
    context.addIssue({
      code: "custom",
      message: "Evidence artifact id must contain its content hash.",
      path: ["id"],
    });
  }
});

export const WorkProcessStepKindSchema = z.enum([
  "tool",
  "validation",
  "state_transition",
  "approval",
  "question",
  "artifact",
  "cleanup",
]);
export const WorkProcessLayerSchema = z.enum(["agent", "environment"]);
export const WorkProcessActionSchema = z.enum([
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_timed_out",
  "tool_invoked",
  "tool_completed",
  "tool_failed",
  "validation_completed",
  "validation_failed",
  "approval_requested",
  "approval_resolved",
  "question_asked",
  "question_answered",
  "question_dismissed",
  "artifact_created",
  "workspace_changed",
  "environment_created",
  "environment_reset",
  "environment_destroyed",
  "cleanup_completed",
  "cleanup_failed",
]);
export const WorkProcessStepStatusSchema = z.enum([
  "started",
  "completed",
  "failed",
  "cancelled",
]);
export const WorkToolCategorySchema = z.enum([
  "filesystem",
  "source_control",
  "command",
  "browser",
  "connected_app",
  "sandbox",
  "agent",
  "other",
]);
export const WorkValidationKindSchema = z.enum([
  "structural",
  "visual",
  "test",
  "user_review",
  "other",
]);
export const WorkTransitionStateSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);
export const WorkInterventionOutcomeSchema = z.enum([
  "requested",
  "approved",
  "denied",
  "answered",
  "dismissed",
]);
export const WorkProcessErrorClassSchema = z.enum([
  "policy",
  "validation",
  "environment",
  "infrastructure",
  "timeout",
  "cancelled",
  "unknown",
]);
export const WorkTraceIncompleteReasonSchema = z.enum([
  "missing_start",
  "missing_terminal",
  "source_truncated",
  "unsupported_events_dropped",
  "uncorrelated_environment_step",
  "artifact_unavailable",
]);

export const WorkProcessStepSchema = z.object({
  sequence: z.number().int().nonnegative().max(1_000_000),
  timestamp: ReleaseTimestampSchema,
  layer: WorkProcessLayerSchema,
  kind: WorkProcessStepKindSchema,
  action: WorkProcessActionSchema,
  status: WorkProcessStepStatusSchema,
  inputHash: ReleaseHashSchema.nullable(),
  outputHash: ReleaseHashSchema.nullable(),
  receiptHash: ReleaseHashSchema.nullable(),
  parentReceiptHash: ReleaseHashSchema.nullable(),
  artifactRefs: z.array(EvidenceArtifactRefSchema).max(1_000),
  attributes: z.object({
    toolCategory: WorkToolCategorySchema.nullable(),
    validationKind: WorkValidationKindSchema.nullable(),
    transitionState: WorkTransitionStateSchema.nullable(),
    interventionOutcome: WorkInterventionOutcomeSchema.nullable(),
    artifactCount: z.number().int().nonnegative().max(100_000),
    exitCode: z.number().int().min(-1).max(255).nullable(),
    durationMs: z.number().int().nonnegative().max(31_536_000_000).nullable(),
    cpuTimeMs: z.number().int().nonnegative().max(31_536_000_000).nullable(),
    memoryPeakBytes: z.number().int().nonnegative().max(1_125_899_906_842_624).nullable(),
    errorClass: WorkProcessErrorClassSchema.nullable(),
  }).strict(),
}).strict().superRefine((step, context) => {
  if (step.layer === "agent" && step.parentReceiptHash !== null) {
    context.addIssue({
      code: "custom",
      message: "Agent-layer steps cannot have a parent environment correlation.",
      path: ["parentReceiptHash"],
    });
  }
  if (step.layer === "environment" && step.parentReceiptHash === null) {
    context.addIssue({
      code: "custom",
      message: "Environment steps must correlate to an Agent receipt.",
      path: ["parentReceiptHash"],
    });
  }
});

export const WorkProcessTraceContentSchema = z.object({
  schemaVersion: z.literal(WORK_PROCESS_TRACE_SCHEMA_VERSION),
  sourceRevisionHash: ReleaseHashSchema,
  sanitationPolicyVersion: ReleaseIdSchema,
  incomplete: z.boolean(),
  incompleteReasons: z.array(WorkTraceIncompleteReasonSchema).max(10),
  droppedEventCount: z.number().int().nonnegative().max(1_000_000),
  steps: z.array(WorkProcessStepSchema).max(100_000),
}).strict().superRefine((trace, context) => {
  if (trace.incomplete !== (trace.incompleteReasons.length > 0)) {
    context.addIssue({
      code: "custom",
      message: "incomplete must match the presence of incompleteReasons.",
      path: ["incomplete"],
    });
  }
  for (let index = 0; index < trace.steps.length; index += 1) {
    if (trace.steps[index]!.sequence !== index) {
      context.addIssue({
        code: "custom",
        message: "Process trace sequences must be contiguous and zero-based.",
        path: ["steps", index, "sequence"],
      });
    }
  }
});
export const WorkProcessTraceSchema = WorkProcessTraceContentSchema.safeExtend({
  contentHash: ReleaseHashSchema,
}).strict();

export const WorkFailureClassSchema = z.enum([
  "policy_failure",
  "validation_failure",
  "model_failure",
  "environment_failure",
  "infrastructure_failure",
  "timeout",
  "cancelled",
  "unknown",
]);
export const WorkTerminalSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled", "timeout"]),
  failureClass: WorkFailureClassSchema.nullable(),
}).strict().superRefine((terminal, context) => {
  if (terminal.status === "completed" && terminal.failureClass !== null) {
    context.addIssue({ code: "custom", message: "Completed Work cannot carry a failure class.", path: ["failureClass"] });
  }
  if (terminal.status !== "completed" && terminal.failureClass === null) {
    context.addIssue({ code: "custom", message: "Non-completed Work requires a failure class.", path: ["failureClass"] });
  }
  if (terminal.status === "cancelled" && terminal.failureClass !== "cancelled") {
    context.addIssue({ code: "custom", message: "Cancelled Work must use the cancelled failure class.", path: ["failureClass"] });
  }
  if (terminal.status === "timeout" && terminal.failureClass !== "timeout") {
    context.addIssue({ code: "custom", message: "Timed-out Work must use the timeout failure class.", path: ["failureClass"] });
  }
});

export const WorkEvidenceReceiptContentSchema = z.object({
  schemaVersion: z.literal(WORK_EVIDENCE_SCHEMA_VERSION),
  id: z.string().regex(/^work-evidence-[a-f0-9]{24}$/),
  source: z.object({
    surface: z.enum(["desktop", "hosted"]),
    experience: z.enum(["work", "development"]),
    opaqueRef: WorkSourceOpaqueRefSchema,
    revisionHash: ReleaseHashSchema,
  }).strict(),
  agentSnapshot: ImmutableReleaseRefSchema.nullable(),
  model: ModelRefSchema,
  runtime: z.object({
    adapterId: ReleaseIdSchema,
    adapterVersion: ReleaseIdSchema,
    capabilityRef: EvidenceArtifactRefSchema.nullable(),
  }).strict(),
  inputHash: ReleaseHashSchema,
  terminal: WorkTerminalSchema,
  trace: z.object({
    sanitizedRef: EvidenceArtifactRefSchema,
    traceHash: ReleaseHashSchema,
    sanitationPolicyVersion: ReleaseIdSchema,
    incomplete: z.boolean(),
  }).strict(),
  outputRefs: z.array(EvidenceArtifactRefSchema).max(10_000),
  artifactRefs: z.array(EvidenceArtifactRefSchema).max(100_000),
  validationEvidenceRefs: z.array(EvidenceArtifactRefSchema).max(10_000),
  interventions: z.object({
    approvals: z.number().int().nonnegative().max(1_000_000),
    questions: z.number().int().nonnegative().max(1_000_000),
    steeringEvents: z.number().int().nonnegative().max(1_000_000),
    otherUserInterventions: z.number().int().nonnegative().max(1_000_000),
  }).strict(),
  timing: z.object({
    startedAt: ReleaseTimestampSchema,
    completedAt: ReleaseTimestampSchema,
    latencyMs: z.number().int().nonnegative().max(31_536_000_000),
  }).strict(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  }).strict(),
  costUsd: z.number().nonnegative().max(1_000_000).nullable(),
  provenance: z.object({
    consentReceiptRef: EvidenceArtifactRefSchema,
    consentScope: z.literal("work_process_and_artifacts"),
    consentGrantedAt: ReleaseTimestampSchema,
    policyVersion: ReleaseIdSchema,
    projectorVersion: ReleaseIdSchema,
    disclosure: z.literal("portable_sanitized"),
    ownershipScope: z.enum(["personal", "workspace"]),
    workspaceRef: WorkWorkspaceOpaqueRefSchema.nullable(),
    participantPolicy: z.enum(["creator_only", "all_participants"]),
    retention: z.object({
      policy: z.literal("source_bound"),
      deleteWithSource: z.literal(true),
      expiresAt: ReleaseTimestampSchema.nullable(),
    }).strict(),
  }).strict(),
}).strict().superRefine((receipt, context) => {
  if (receipt.trace.traceHash !== receipt.trace.sanitizedRef.contentHash) {
    context.addIssue({
      code: "custom",
      message: "Sanitized trace reference must bind traceHash.",
      path: ["trace", "traceHash"],
    });
  }
  const elapsed = Date.parse(receipt.timing.completedAt) - Date.parse(receipt.timing.startedAt);
  if (elapsed < 0 || elapsed !== receipt.timing.latencyMs) {
    context.addIssue({
      code: "custom",
      message: "latencyMs must equal completedAt minus startedAt.",
      path: ["timing", "latencyMs"],
    });
  }
  if (receipt.provenance.ownershipScope === "workspace" && receipt.provenance.workspaceRef === null) {
    context.addIssue({ code: "custom", message: "Workspace-owned evidence requires workspaceRef.", path: ["provenance", "workspaceRef"] });
  }
  if (receipt.provenance.ownershipScope === "personal" && receipt.provenance.workspaceRef !== null) {
    context.addIssue({ code: "custom", message: "Personal evidence cannot carry workspaceRef.", path: ["provenance", "workspaceRef"] });
  }
  addDuplicateHashIssues(receipt.outputRefs, ["outputRefs"], context);
  addDuplicateHashIssues(receipt.artifactRefs, ["artifactRefs"], context);
  addDuplicateHashIssues(receipt.validationEvidenceRefs, ["validationEvidenceRefs"], context);
});
export const WorkEvidenceReceiptSchema = WorkEvidenceReceiptContentSchema.safeExtend({
  contentHash: ReleaseHashSchema,
}).strict();

export const WorkFeedbackVerdictSchema = z.enum([
  "accepted",
  "needs_correction",
  "not_useful",
]);
export const WorkFeedbackReasonCodeSchema = z.enum([
  "correct",
  "complete",
  "high_quality",
  "incorrect",
  "incomplete",
  "wrong_format",
  "unsafe",
  "stale",
  "irrelevant",
  "other",
]);
export const WorkFeedbackReceiptContentSchema = z.object({
  schemaVersion: z.literal(WORK_FEEDBACK_SCHEMA_VERSION),
  id: z.string().regex(/^work-feedback-[a-f0-9]{24}$/),
  evidenceReceiptRef: EvidenceArtifactRefSchema,
  outputRevisionRef: EvidenceArtifactRefSchema.nullable(),
  verdict: WorkFeedbackVerdictSchema,
  reasonCodes: z.array(WorkFeedbackReasonCodeSchema).max(16),
  correctionRef: EvidenceArtifactRefSchema.nullable(),
  correctedOutputRevisionRef: EvidenceArtifactRefSchema.nullable(),
  actor: z.literal("user"),
  createdAt: ReleaseTimestampSchema,
}).strict().superRefine((feedback, context) => {
  if (new Set(feedback.reasonCodes).size !== feedback.reasonCodes.length) {
    context.addIssue({ code: "custom", message: "Feedback reason codes must be unique.", path: ["reasonCodes"] });
  }
  if (feedback.verdict !== "needs_correction" && (feedback.correctionRef || feedback.correctedOutputRevisionRef)) {
    context.addIssue({
      code: "custom",
      message: "Only needs_correction feedback may bind correction artifacts.",
      path: ["verdict"],
    });
  }
});
export const WorkFeedbackReceiptSchema = WorkFeedbackReceiptContentSchema.safeExtend({
  contentHash: ReleaseHashSchema,
}).strict();

export function evidenceArtifactId(hash: string): string {
  return `urn:openpond:artifact:${hash}`;
}

export function workSourceOpaqueRef(sourceIdentity: unknown): string {
  return `urn:openpond:work:${contentHash(sourceIdentity)}`;
}

export function workWorkspaceOpaqueRef(workspaceIdentity: unknown): string {
  return `urn:openpond:workspace:${contentHash(workspaceIdentity)}`;
}

export function evidenceArtifactRef(input: {
  contentHash: string;
  mediaType?: string | null;
  sizeBytes?: number | null;
}): EvidenceArtifactRef {
  return EvidenceArtifactRefSchema.parse({
    id: evidenceArtifactId(input.contentHash),
    contentHash: input.contentHash,
    mediaType: input.mediaType ?? null,
    sizeBytes: input.sizeBytes ?? null,
  });
}

export function createWorkProcessTrace(
  input: z.input<typeof WorkProcessTraceContentSchema>,
): WorkProcessTrace {
  const trace = WorkProcessTraceContentSchema.parse(input);
  return WorkProcessTraceSchema.parse({ ...trace, contentHash: contentHash(trace) });
}

export function createWorkEvidenceReceipt(
  input: z.input<typeof WorkEvidenceReceiptContentSchema>,
): WorkEvidenceReceipt {
  const receipt = WorkEvidenceReceiptContentSchema.parse(input);
  return WorkEvidenceReceiptSchema.parse({ ...receipt, contentHash: contentHash(receipt) });
}

export function createWorkFeedbackReceipt(
  input: z.input<typeof WorkFeedbackReceiptContentSchema>,
  evidence?: WorkEvidenceReceipt,
): WorkFeedbackReceipt {
  const feedback = WorkFeedbackReceiptContentSchema.parse(input);
  const receipt = WorkFeedbackReceiptSchema.parse({ ...feedback, contentHash: contentHash(feedback) });
  if (evidence) assertFeedbackTargetsEvidence(receipt, evidence);
  return receipt;
}

export function verifyWorkProcessTrace(value: unknown): value is WorkProcessTrace {
  return verifyHashedValue(value, WorkProcessTraceSchema, WorkProcessTraceContentSchema);
}

export function verifyWorkEvidenceReceipt(value: unknown): value is WorkEvidenceReceipt {
  return verifyHashedValue(value, WorkEvidenceReceiptSchema, WorkEvidenceReceiptContentSchema);
}

export function verifyWorkFeedbackReceipt(value: unknown): value is WorkFeedbackReceipt {
  return verifyHashedValue(value, WorkFeedbackReceiptSchema, WorkFeedbackReceiptContentSchema);
}

export function workEvidenceReceiptRef(receipt: WorkEvidenceReceipt): EvidenceArtifactRef {
  return evidenceArtifactRef({
    contentHash: receipt.contentHash,
    mediaType: "application/vnd.openpond.work-evidence+json",
    sizeBytes: null,
  });
}

export function assertFeedbackTargetsEvidence(
  feedback: WorkFeedbackReceipt,
  evidence: WorkEvidenceReceipt,
): void {
  if (feedback.evidenceReceiptRef.contentHash !== evidence.contentHash) {
    throw new Error("Feedback targets a different Work evidence receipt.");
  }
  if (
    feedback.outputRevisionRef
    && !evidence.outputRefs.some((output) => output.contentHash === feedback.outputRevisionRef!.contentHash)
  ) {
    throw new Error("Feedback targets an output revision not bound by the Work evidence receipt.");
  }
}

function verifyHashedValue<Schema extends z.ZodType>(
  value: unknown,
  schema: Schema,
  contentSchema: z.ZodType,
): boolean {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...content } = parsed.data as Record<string, unknown> & { contentHash: string };
  return contentHash(contentSchema.parse(content)) === actual;
}

function addDuplicateHashIssues(
  artifacts: ImmutableArtifactRef[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const hashes = artifacts.map((artifact) => artifact.contentHash);
  if (new Set(hashes).size !== hashes.length) {
    context.addIssue({ code: "custom", message: "Artifact content hashes must be unique.", path });
  }
}

export type EvidenceArtifactRef = z.infer<typeof EvidenceArtifactRefSchema>;
export type WorkProcessStep = z.infer<typeof WorkProcessStepSchema>;
export type WorkProcessTrace = z.infer<typeof WorkProcessTraceSchema>;
export type WorkEvidenceReceipt = z.infer<typeof WorkEvidenceReceiptSchema>;
export type WorkFeedbackReceipt = z.infer<typeof WorkFeedbackReceiptSchema>;
export type WorkFeedbackVerdict = z.infer<typeof WorkFeedbackVerdictSchema>;
export type WorkFeedbackReasonCode = z.infer<typeof WorkFeedbackReasonCodeSchema>;
