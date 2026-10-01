import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { RunExperimentSchema } from "./experiment-run-contracts.js";
const Id = z.string().trim().min(1).max(200),
  Hash = z.string().regex(/^[a-f0-9]{64}$/),
  Ref = z.object({ id: Id, contentHash: Hash }).strict();
export const CandidateEvaluationOptionSchema = z
  .object({
    artifact: Ref,
    trainingJobId: Id,
    configurationId: Id,
    baseProfileId: Id,
    ready: z.boolean(),
    reason: z.string().max(1000).nullable(),
  })
  .strict();
export const CandidateEvaluationOptionsSchema = z
  .object({
    teamId: Id,
    ownerUserId: Id,
    items: z.array(CandidateEvaluationOptionSchema).max(100),
    nextCursor: Id.nullable(),
  })
  .strict();
export const CandidateEvaluationRequestSchema = z
  .object({ teamId: Id, operationId: Id, artifact: Ref, configuration: RunExperimentSchema })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.configuration.request.teamId !== value.teamId ||
      value.configuration.request.policy.kind === "fixture" ||
      value.configuration.request.policy.candidate
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose one exact model-backed evaluation before preparing the trained version.",
      });
  });
export const CandidateEvaluationPreparationSchema = z
  .object({
    schemaVersion: z.literal("openpond.candidateEvaluationPreparation.v1"),
    teamId: Id,
    ownerUserId: Id,
    id: Id,
    revision: z.number().int().positive(),
    requestHash: Hash,
    request: CandidateEvaluationRequestSchema,
    trainingJobId: Id,
    dispatchId: Id,
    lastOperationId: Id.nullable(),
    runtime: z
      .object({
        poolId: Id,
        endpointId: Id.nullable(),
        baseProfileId: Id,
        workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        modelId: Id.nullable(),
      })
      .strict()
      .nullable(),
    state: z.enum([
      "configured",
      "preparing",
      "ready",
      "dispatching",
      "submitted",
      "cleaning",
      "completed",
      "failed",
      "cancelled",
    ]),
    experimentId: Id.nullable(),
    authorizedAt: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    reason: z.string().max(1000).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.requestHash !== contentHash(value.request) ||
      (!value.runtime && ["ready", "dispatching", "submitted", "completed"].includes(value.state))
    )
      ctx.addIssue({
        code: "custom",
        message: "The exact candidate preparation request or runtime changed.",
      });
  });
export const CandidateEvaluationControlSchema = z
  .object({ operationId: Id, expectedRevision: z.number().int().positive(), requestHash: Hash })
  .strict();
export type CandidateEvaluationPreparation = z.infer<typeof CandidateEvaluationPreparationSchema>;
export type CandidateEvaluationRequest = z.infer<typeof CandidateEvaluationRequestSchema>;
export type CandidateEvaluationOption = z.infer<typeof CandidateEvaluationOptionSchema>;
export { createCandidateEvaluationClient } from "./candidate-evaluation-client.js";
