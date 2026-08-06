import { z } from "zod";

import { contentHash, ReleaseHashSchema } from "@openpond/harness";
import { AttemptReceiptSchema, verifyAttemptReceipt, type AttemptReceipt } from "../runs.js";
import {
  WORK_EVIDENCE_ELIGIBILITY_SCHEMA_VERSION,
  WorkFeedbackReceiptSchema,
  createWorkFeedbackReceipt,
  verifyWorkEvidenceReceipt,
  type WorkEvidenceReceipt,
  type WorkFeedbackReceipt,
} from "./contracts.js";

export const WorkEvidencePolicyStateSchema = z.enum([
  "active",
  "revoked",
  "deleted",
  "expired",
]);
export const WorkEvidenceUseSchema = z.enum([
  "discovery_only",
  "eval_candidate",
  "demonstration_candidate",
  "preference_candidate",
  "reward_candidate",
]);
export const WorkEvidenceBlockerCodeSchema = z.enum([
  "invalid_evidence_receipt",
  "consent_revoked",
  "source_deleted",
  "retention_expired",
  "trace_incomplete",
  "terminal_not_completed",
  "infrastructure_failure",
  "agent_snapshot_missing",
  "input_not_reconstructable",
  "environment_not_reconstructable",
  "output_missing",
  "validation_evidence_missing",
  "verifier_missing",
  "accepted_feedback_missing",
  "correction_pair_missing",
  "attempt_receipt_missing",
  "attempt_receipt_invalid",
  "attempt_receipt_unbound",
  "attempt_not_reward_eligible",
]);
export const WorkEvidenceDecisionSchema = z.object({
  eligible: z.boolean(),
  blockers: z.array(WorkEvidenceBlockerCodeSchema).max(32),
}).strict().superRefine((decision, context) => {
  if (decision.eligible === (decision.blockers.length > 0)) {
    context.addIssue({ code: "custom", message: "Eligibility must be the inverse of blocker presence." });
  }
});
export const WorkEvidenceEligibilityContentSchema = z.object({
  schemaVersion: z.literal(WORK_EVIDENCE_ELIGIBILITY_SCHEMA_VERSION),
  evidenceReceiptHash: ReleaseHashSchema,
  policyState: WorkEvidencePolicyStateSchema,
  decisions: z.object({
    discovery_only: WorkEvidenceDecisionSchema,
    eval_candidate: WorkEvidenceDecisionSchema,
    demonstration_candidate: WorkEvidenceDecisionSchema,
    preference_candidate: WorkEvidenceDecisionSchema,
    reward_candidate: WorkEvidenceDecisionSchema,
  }).strict(),
}).strict();
export const WorkEvidenceEligibilitySchema = WorkEvidenceEligibilityContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();

export type WorkEvidenceEligibilityInput = {
  evidence: WorkEvidenceReceipt;
  feedback?: WorkFeedbackReceipt[];
  policyState: z.infer<typeof WorkEvidencePolicyStateSchema>;
  reconstructability: {
    input: boolean;
    environment: boolean;
    verifier: boolean;
  };
  replay?: {
    attemptReceipt: AttemptReceipt;
    sourceEvidenceReceiptHash: string;
  } | null;
};

export function classifyWorkEvidence(input: WorkEvidenceEligibilityInput): WorkEvidenceEligibility {
  const evidenceValid = verifyWorkEvidenceReceipt(input.evidence);
  const validFeedback = (input.feedback ?? []).filter((feedback) => {
    if (!WorkFeedbackReceiptSchema.safeParse(feedback).success) return false;
    try {
      createWorkFeedbackReceipt(withoutHash(feedback), input.evidence);
      return true;
    } catch {
      return false;
    }
  });
  const policyBlockers = policyStateBlockers(input.policyState);
  const discovery = [
    ...(!evidenceValid ? ["invalid_evidence_receipt" as const] : []),
    ...policyBlockers,
  ];
  const evaluation = [
    ...discovery,
    ...(input.evidence.trace.incomplete ? ["trace_incomplete" as const] : []),
    ...(!input.evidence.agentSnapshot ? ["agent_snapshot_missing" as const] : []),
    ...(!input.reconstructability.input ? ["input_not_reconstructable" as const] : []),
    ...(!input.reconstructability.environment ? ["environment_not_reconstructable" as const] : []),
    ...(!input.evidence.outputRefs.length ? ["output_missing" as const] : []),
    ...(!input.reconstructability.verifier ? ["verifier_missing" as const] : []),
  ];
  const completed = input.evidence.terminal.status === "completed";
  const accepted = validFeedback.some((feedback) => feedback.verdict === "accepted");
  const demonstration = [
    ...evaluation,
    ...(!completed ? ["terminal_not_completed" as const] : []),
    ...(input.evidence.terminal.failureClass === "infrastructure_failure" ? ["infrastructure_failure" as const] : []),
    ...(!input.evidence.validationEvidenceRefs.length ? ["validation_evidence_missing" as const] : []),
    ...(!accepted ? ["accepted_feedback_missing" as const] : []),
  ];
  const acceptedOutputs = new Set(
    validFeedback
      .filter((feedback) => feedback.verdict === "accepted")
      .flatMap((feedback) => feedback.outputRevisionRef?.contentHash ?? []),
  );
  const correctionPair = validFeedback.some((feedback) =>
    feedback.verdict === "needs_correction"
    && feedback.outputRevisionRef !== null
    && feedback.correctedOutputRevisionRef !== null
    && acceptedOutputs.has(feedback.correctedOutputRevisionRef.contentHash),
  );
  const preference = [
    ...evaluation,
    ...(!correctionPair ? ["correction_pair_missing" as const] : []),
  ];
  const replay = input.replay ?? null;
  const replayParsed = replay ? AttemptReceiptSchema.safeParse(replay.attemptReceipt) : null;
  const replayValid = replayParsed?.success === true && verifyAttemptReceipt(replayParsed.data);
  const replayBound = replay?.sourceEvidenceReceiptHash === input.evidence.contentHash;
  const replayEligible = replayValid
    && replayBound
    && replay!.attemptReceipt.terminal
    && replay!.attemptReceipt.failureClass !== "infrastructure_failure"
    && replay!.attemptReceipt.failureClass !== "timeout"
    && replay!.attemptReceipt.failureClass !== "cancelled"
    && replay!.attemptReceipt.metadata.rewardEligible === true
    && typeof replay!.attemptReceipt.metadata.score === "number";
  const reward = [
    ...discovery,
    ...(!replay ? ["attempt_receipt_missing" as const] : []),
    ...(replay && !replayValid ? ["attempt_receipt_invalid" as const] : []),
    ...(replay && !replayBound ? ["attempt_receipt_unbound" as const] : []),
    ...(replay && replayValid && replayBound && !replayEligible ? ["attempt_not_reward_eligible" as const] : []),
  ];
  const report = WorkEvidenceEligibilityContentSchema.parse({
    schemaVersion: WORK_EVIDENCE_ELIGIBILITY_SCHEMA_VERSION,
    evidenceReceiptHash: input.evidence.contentHash,
    policyState: input.policyState,
    decisions: {
      discovery_only: decision(discovery),
      eval_candidate: decision(evaluation),
      demonstration_candidate: decision(demonstration),
      preference_candidate: decision(preference),
      reward_candidate: decision(reward),
    },
  });
  return WorkEvidenceEligibilitySchema.parse({ ...report, contentHash: contentHash(report) });
}

export function verifyWorkEvidenceEligibility(value: unknown): value is WorkEvidenceEligibility {
  const parsed = WorkEvidenceEligibilitySchema.safeParse(value);
  if (!parsed.success) return false;
  const { contentHash: actual, ...report } = parsed.data;
  return contentHash(WorkEvidenceEligibilityContentSchema.parse(report)) === actual;
}

export function eligibleEvidenceUses(report: WorkEvidenceEligibility): WorkEvidenceUse[] {
  return WorkEvidenceUseSchema.options.filter((use) => report.decisions[use].eligible);
}

function policyStateBlockers(
  state: z.infer<typeof WorkEvidencePolicyStateSchema>,
): WorkEvidenceBlockerCode[] {
  if (state === "revoked") return ["consent_revoked"];
  if (state === "deleted") return ["source_deleted"];
  if (state === "expired") return ["retention_expired"];
  return [];
}

function decision(blockers: WorkEvidenceBlockerCode[]) {
  const unique = [...new Set(blockers)];
  return WorkEvidenceDecisionSchema.parse({ eligible: unique.length === 0, blockers: unique });
}

function withoutHash<T extends { contentHash: string }>(value: T): Omit<T, "contentHash"> {
  const { contentHash: _contentHash, ...content } = value;
  return content;
}

export type WorkEvidencePolicyState = z.infer<typeof WorkEvidencePolicyStateSchema>;
export type WorkEvidenceUse = z.infer<typeof WorkEvidenceUseSchema>;
export type WorkEvidenceBlockerCode = z.infer<typeof WorkEvidenceBlockerCodeSchema>;
export type WorkEvidenceEligibility = z.infer<typeof WorkEvidenceEligibilitySchema>;
