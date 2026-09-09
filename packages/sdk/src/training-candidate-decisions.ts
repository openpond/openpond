import { z } from "zod";
import { ModelProjectImmutableRefSchema } from "./model-projects.js";
import {
  OpenPondProtocolError,
  assertCanonicalPayloadSize,
  canonicalSha256,
} from "./protocol.js";

const IdSchema = /* @__PURE__ */ (() => z.string().trim().min(1).max(500))();
const HashSchema = /* @__PURE__ */ (() => z.string().regex(/^[a-f0-9]{64}$/))();

/** A reviewed candidate decision never activates serving or alters training evidence. */
export const TrainingCandidateDecisionRequestSchema = /* @__PURE__ */ (() => z.object({
  schemaVersion: z.literal("openpond.trainingCandidateDecisionRequest.v1"),
  teamId: IdSchema,
  jobId: IdSchema,
  artifact: ModelProjectImmutableRefSchema,
  evaluation: ModelProjectImmutableRefSchema,
  executionReceipt: ModelProjectImmutableRefSchema,
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().min(1).max(5_000),
  idempotencyKey: IdSchema,
  expectedDecision: ModelProjectImmutableRefSchema.nullable(),
}).strict())();

/** Append-only, authenticated hosted record. Hash verification is not a signature. */
export const TrainingCandidateDecisionSchema = /* @__PURE__ */ (() => z.object({
  schemaVersion: z.literal("openpond.trainingCandidateDecision.v1"),
  id: IdSchema,
  request: TrainingCandidateDecisionRequestSchema,
  revision: z.number().int().positive(),
  actor: z.object({ userId: IdSchema, kind: z.enum(["user", "api_key", "agent_delegate"]), id: IdSchema }).strict(),
  decidedAt: z.string().datetime({ offset: true }),
  contentHash: HashSchema,
}).strict().superRefine((value, context) => {
  if ((value.revision === 1) !== (value.request.expectedDecision === null)) {
    context.addIssue({ code: "custom", path: ["revision"], message: "A first decision has no predecessor; later decisions must reference the prior decision." });
  }
  if (value.request.expectedDecision?.id === value.id) {
    context.addIssue({ code: "custom", path: ["request", "expectedDecision"], message: "A decision cannot supersede itself." });
  }
}))();

export type TrainingCandidateDecisionRequest = z.infer<typeof TrainingCandidateDecisionRequestSchema>;
export type TrainingCandidateDecision = z.infer<typeof TrainingCandidateDecisionSchema>;
export type TrainingCandidateDecisionTarget = Pick<TrainingCandidateDecisionRequest, "teamId" | "jobId" | "artifact">;

export async function trainingCandidateDecisionHash(
  value: Omit<TrainingCandidateDecision, "contentHash"> | TrainingCandidateDecision,
): Promise<string> {
  const { contentHash: _contentHash, ...content } = value as TrainingCandidateDecision;
  return canonicalSha256(content);
}

export async function parseAndVerifyTrainingCandidateDecision(
  value: unknown,
  expected: TrainingCandidateDecisionTarget & { request?: TrainingCandidateDecisionRequest },
): Promise<TrainingCandidateDecision> {
  assertCanonicalPayloadSize(value, 32_768, "Training candidate decision");
  const parsed = TrainingCandidateDecisionSchema.parse(value);
  if (parsed.contentHash !== await trainingCandidateDecisionHash(parsed)) {
    throw new OpenPondProtocolError("content_hash_mismatch", "Training candidate decision content hash does not match.");
  }
  if (parsed.request.teamId !== expected.teamId || parsed.request.jobId !== expected.jobId
    || parsed.request.artifact.id !== expected.artifact.id
    || parsed.request.artifact.contentHash !== expected.artifact.contentHash) {
    throw new OpenPondProtocolError("candidate_decision_identity_mismatch", "Training candidate decision belongs to a different team, Job or artifact.");
  }
  if (expected.request && await canonicalSha256(parsed.request) !== await canonicalSha256(TrainingCandidateDecisionRequestSchema.parse(expected.request))) {
    throw new OpenPondProtocolError("candidate_decision_request_mismatch", "Training candidate decision does not match the submitted review.");
  }
  return parsed;
}

export function createTrainingCandidateDecisionClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
) {
  function route(target: TrainingCandidateDecisionTarget) {
    return `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(target.jobId))}/candidates/${encodeURIComponent(ModelProjectImmutableRefSchema.parse(target.artifact).id)}/decision`;
  }
  return {
    async candidateDecision(
      target: TrainingCandidateDecisionTarget,
      options: { decision?: { id: string; contentHash: string } } = {},
    ): Promise<TrainingCandidateDecision | null> {
      IdSchema.parse(target.teamId);
      const reference = options.decision ? ModelProjectImmutableRefSchema.parse(options.decision) : undefined;
      const query = reference ? `?decisionId=${encodeURIComponent(reference.id)}` : "";
      const response = z.object({ decision: z.unknown().nullable() }).strict().parse(await request(`${route(target)}${query}`));
      if (response.decision === null && !reference) return null;
      const decision = await parseAndVerifyTrainingCandidateDecision(response.decision, target);
      if (reference && (decision.id !== reference.id || decision.contentHash !== reference.contentHash)) {
        throw new OpenPondProtocolError("candidate_decision_identity_mismatch", "Training candidate decision does not match the requested history entry.");
      }
      return decision;
    },
    async recordCandidateDecision(input: TrainingCandidateDecisionRequest): Promise<TrainingCandidateDecision> {
      const parsed = TrainingCandidateDecisionRequestSchema.parse(input);
      const response = await request(route(parsed), { method: "POST", body: JSON.stringify(parsed) });
      return parseAndVerifyTrainingCandidateDecision(response, { ...parsed, request: parsed });
    },
  };
}
