import { canonicalJson, contentHash } from "../common.js";
import {
  createWorkEvidenceReceipt,
  createWorkFeedbackReceipt,
  createWorkProcessTrace,
  evidenceArtifactRef,
  workEvidenceReceiptRef,
  workSourceOpaqueRef,
} from "./contracts.js";
import { classifyWorkEvidence } from "./eligibility.js";

const startedAt = "2026-08-04T12:00:00.000Z";
const completedAt = "2026-08-04T12:00:02.500Z";
const sourceRevisionHash = contentHash({ fixture: "desktop-work", revision: 1 });
const output = evidenceArtifactRef({
  contentHash: contentHash("fixture output"),
  mediaType: "text/plain",
  sizeBytes: 14,
});
const validation = evidenceArtifactRef({
  contentHash: contentHash({ kind: "test", status: "passed" }),
  mediaType: "application/json",
  sizeBytes: null,
});
const consent = evidenceArtifactRef({
  contentHash: contentHash({ scope: "work_process_and_artifacts", grantedAt: startedAt }),
  mediaType: "application/json",
  sizeBytes: null,
});

export const completeWorkProcessTraceFixture = createWorkProcessTrace({
  schemaVersion: "openpond.workProcessTrace.v1",
  sourceRevisionHash,
  sanitationPolicyVersion: "openpond.desktop-work-sanitizer.v1",
  incomplete: false,
  incompleteReasons: [],
  droppedEventCount: 1,
  steps: [
    step(0, startedAt, "agent", "state_transition", "turn_started", "started", {
      transitionState: "running",
    }),
    step(1, "2026-08-04T12:00:00.500Z", "agent", "tool", "tool_invoked", "started", {
      toolCategory: "filesystem",
      inputHash: contentHash({ path: "hashed-only" }),
      receiptHash: contentHash("fixture-tool-call"),
    }),
    step(2, "2026-08-04T12:00:01.000Z", "environment", "artifact", "artifact_created", "completed", {
      outputHash: output.contentHash,
      artifacts: [output],
      receiptHash: contentHash("fixture-environment-operation"),
      parentReceiptHash: contentHash("fixture-tool-call"),
    }),
    step(3, "2026-08-04T12:00:01.500Z", "environment", "validation", "validation_completed", "completed", {
      validationKind: "test",
      outputHash: validation.contentHash,
      receiptHash: contentHash("fixture-validation"),
      parentReceiptHash: contentHash("fixture-tool-call"),
    }),
    step(4, completedAt, "agent", "state_transition", "turn_completed", "completed", {
      transitionState: "completed",
    }),
  ],
});

const traceBytes = new TextEncoder().encode(canonicalJson(completeWorkProcessTraceFixture)).byteLength;
const traceRef = evidenceArtifactRef({
  contentHash: completeWorkProcessTraceFixture.contentHash,
  mediaType: "application/vnd.openpond.work-process-trace+json",
  sizeBytes: traceBytes,
});

export const completeWorkEvidenceFixture = createWorkEvidenceReceipt({
  schemaVersion: "openpond.workEvidenceReceipt.v1",
  id: `work-evidence-${contentHash([sourceRevisionHash, traceRef.contentHash]).slice(0, 24)}`,
  source: {
    surface: "desktop",
    experience: "work",
    opaqueRef: workSourceOpaqueRef(["fixture-session", "fixture-turn"]),
    revisionHash: sourceRevisionHash,
  },
  agentSnapshot: { id: "fixture-agent-snapshot", contentHash: contentHash("fixture-agent") },
  model: {
    provider: "fixture",
    model: "scripted",
    revision: "1",
    artifactHash: null,
    tokenizerRevision: null,
    chatTemplateHash: null,
  },
  runtime: {
    adapterId: "desktop-work",
    adapterVersion: "1",
    capabilityRef: null,
  },
  inputHash: contentHash("fixture prompt"),
  terminal: { status: "completed", failureClass: null },
  trace: {
    sanitizedRef: traceRef,
    traceHash: traceRef.contentHash,
    sanitationPolicyVersion: completeWorkProcessTraceFixture.sanitationPolicyVersion,
    incomplete: false,
  },
  outputRefs: [output],
  artifactRefs: [output],
  validationEvidenceRefs: [validation],
  interventions: { approvals: 0, questions: 0, steeringEvents: 0, otherUserInterventions: 0 },
  timing: { startedAt, completedAt, latencyMs: 2_500 },
  usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
  costUsd: 0,
  provenance: {
    consentReceiptRef: consent,
    consentScope: "work_process_and_artifacts",
    consentGrantedAt: startedAt,
    policyVersion: "openpond.work-evidence-policy.v1",
    projectorVersion: "openpond.desktop-work-evidence-projector.v1",
    disclosure: "portable_sanitized",
    ownershipScope: "personal",
    workspaceRef: null,
    participantPolicy: "creator_only",
    retention: { policy: "source_bound", deleteWithSource: true, expiresAt: null },
  },
});

export const acceptedWorkFeedbackFixture = createWorkFeedbackReceipt({
  schemaVersion: "openpond.workFeedbackReceipt.v1",
  id: `work-feedback-${contentHash([completeWorkEvidenceFixture.contentHash, "accepted"]).slice(0, 24)}`,
  evidenceReceiptRef: workEvidenceReceiptRef(completeWorkEvidenceFixture),
  outputRevisionRef: output,
  verdict: "accepted",
  reasonCodes: ["correct", "complete"],
  correctionRef: null,
  correctedOutputRevisionRef: null,
  actor: "user",
  createdAt: "2026-08-04T12:01:00.000Z",
}, completeWorkEvidenceFixture);

export const incompleteWorkProcessTraceFixture = createWorkProcessTrace({
  schemaVersion: "openpond.workProcessTrace.v1",
  sourceRevisionHash: contentHash({ fixture: "incomplete", revision: 1 }),
  sanitationPolicyVersion: "openpond.desktop-work-sanitizer.v1",
  incomplete: true,
  incompleteReasons: ["missing_terminal", "unsupported_events_dropped"],
  droppedEventCount: 2,
  steps: [step(0, startedAt, "agent", "state_transition", "turn_started", "started", {
    transitionState: "running",
  })],
});

export const activeWorkEvidenceEligibilityFixture = classifyWorkEvidence({
  evidence: completeWorkEvidenceFixture,
  feedback: [acceptedWorkFeedbackFixture],
  policyState: "active",
  reconstructability: { input: true, environment: true, verifier: true },
});

export const revokedWorkEvidenceEligibilityFixture = classifyWorkEvidence({
  evidence: completeWorkEvidenceFixture,
  feedback: [acceptedWorkFeedbackFixture],
  policyState: "revoked",
  reconstructability: { input: true, environment: true, verifier: true },
});

export const invalidRawEvidenceFixture = {
  ...completeWorkEvidenceFixture,
  source: {
    ...completeWorkEvidenceFixture.source,
    opaqueRef: "raw-database-turn-id",
  },
  privateRef: "/private/runtime/trace.json",
  publicData: {
    reasoning: "hidden model reasoning",
    apiKey: "secret-like-value",
  },
};

export const workEvidenceConformance = {
  trace: completeWorkProcessTraceFixture,
  receipt: completeWorkEvidenceFixture,
  feedback: acceptedWorkFeedbackFixture,
  activeEligibility: activeWorkEvidenceEligibilityFixture,
  revokedEligibility: revokedWorkEvidenceEligibilityFixture,
  incompleteTrace: incompleteWorkProcessTraceFixture,
  invalidRawEvidence: invalidRawEvidenceFixture,
} as const;

function step(
  sequence: number,
  timestamp: string,
  layer: "agent" | "environment",
  kind: "tool" | "validation" | "state_transition" | "approval" | "question" | "artifact" | "cleanup",
  action: "turn_started" | "turn_completed" | "tool_invoked" | "artifact_created" | "validation_completed",
  status: "started" | "completed" | "failed" | "cancelled",
  input: {
    inputHash?: string;
    outputHash?: string;
    artifacts?: typeof output[];
    toolCategory?: "filesystem";
    validationKind?: "test";
    transitionState?: "running" | "completed";
    receiptHash?: string;
    parentReceiptHash?: string;
  },
) {
  return {
    sequence,
    timestamp,
    layer,
    kind,
    action,
    status,
    inputHash: input.inputHash ?? null,
    outputHash: input.outputHash ?? null,
    receiptHash: input.receiptHash ?? null,
    parentReceiptHash: input.parentReceiptHash ?? null,
    artifactRefs: input.artifacts ?? [],
    attributes: {
      toolCategory: input.toolCategory ?? null,
      validationKind: input.validationKind ?? null,
      transitionState: input.transitionState ?? null,
      interventionOutcome: null,
      artifactCount: input.artifacts?.length ?? 0,
      exitCode: null,
      durationMs: null,
      cpuTimeMs: null,
      memoryPeakBytes: null,
      errorClass: null,
    },
  };
}
