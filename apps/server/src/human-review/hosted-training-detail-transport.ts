import {
  AlphaEditModelServingControlRequestSchema,
  DecisionModelServingControlRequestSchema,
  EngramModelServingControlRequestSchema,
  NeuronTrainingModelServingControlRequestSchema,
  WeightSpaceModelServingControlRequestSchema,
  SteeringModelServingControlRequestSchema,
} from "openpond-sdk/training";
import { RunFeedbackTargetSchema } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { z } from "zod";
import { HostedDecisionExecutionError } from "../training/hosted-decision-executions.js";
import { createHostedTrainingRunDetail } from "../training/hosted-training-run-detail.js";
import { validateReviewedEvaluationCommand } from "../training/reviewed-evaluation-operation.js";
import type { createTrainingApi } from "../training/training-api.js";
import type { SqliteStore } from "../store/store.js";

/** Hosted run and saved-model reads and controls retain the active account at I/O. */
export function createHostedTrainingDetailTransport(deps: {
  store: SqliteStore;
  actorId: () => Promise<string>;
  teamId: () => Promise<string>;
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string }>;
  trainingRequest: ReturnType<typeof createTrainingApi>["request"];
}): ReturnType<typeof createTrainingApi>["request"] {
  return async (action, payload, requestUrl, signal) => {
    if (action === "hosted_training_model_serving_control") {
      const body = z
        .object({
          teamId: z.string().min(1),
          modelProjectId: z.string().min(1).max(240),
          command: z.unknown(),
          review: z
            .object({
              intentHash: z.string().regex(/^[a-f0-9]{64}$/),
              projectId: z.string().min(1).max(240).nullable(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reload this Model.");
      const decision = z
        .union([
          DecisionModelServingControlRequestSchema,
          AlphaEditModelServingControlRequestSchema,
          NeuronTrainingModelServingControlRequestSchema,
  WeightSpaceModelServingControlRequestSchema,
        ])
        .safeParse(body.command);
      if (decision.success) {
        if (!body.review)
          throw new HostedDecisionExecutionError(
            "decision_serving_review_required",
            "Recover the original reviewed decision serving control.",
          );
        const projectId = body.review.projectId,
          apiOrigin = new URL(access.apiBaseUrl).origin;
        const command = { modelProjectId: body.modelProjectId, request: decision.data };
        const retained = await deps.store.readPendingEvaluationOperation({
          scopeHash: contentHash({ actorId, apiOrigin, teamId, projectId }),
          action: "training-model-serving-control",
          intentHash: body.review.intentHash,
          id: decision.data.operationId,
        });
        if (
          retained.phase !== "dispatching" ||
          contentHash(retained.command) !== contentHash(command)
        )
          throw new HostedDecisionExecutionError(
            "decision_serving_review_required",
            "Recover the original reviewed decision serving control.",
          );
        validateReviewedEvaluationCommand({
          action: "training-model-serving-control",
          id: decision.data.operationId,
          actorId,
          teamId,
          projectId,
          intent: retained.reviewedIntent,
          command,
        });
      }
      const detail = createHostedTrainingRunDetail({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
      });
      return AlphaEditModelServingControlRequestSchema.safeParse(body.command).success
        ? detail.controlAlphaEditModelServing(body.modelProjectId, body.command)
        : NeuronTrainingModelServingControlRequestSchema.safeParse(body.command).success
          ? detail.controlNeuronTrainingModelServing(body.modelProjectId, body.command)
        : WeightSpaceModelServingControlRequestSchema.safeParse(body.command).success
          ? detail.controlWeightSpaceModelServing(body.modelProjectId, body.command)
          : DecisionModelServingControlRequestSchema.safeParse(body.command).success
            ? detail.controlDecisionModelServing(body.modelProjectId, body.command)
            : EngramModelServingControlRequestSchema.safeParse(body.command).success
              ? detail.controlEngramModelServing(body.modelProjectId, body.command)
              : SteeringModelServingControlRequestSchema.safeParse(body.command).success
                ? detail.controlSteeringModelServing(body.modelProjectId, body.command)
                : detail.controlModelServing(body.modelProjectId, body.command);
    }
    if (action === "hosted_training_model_serving") {
      const body = z
        .object({
          teamId: z.string().min(1),
          modelProjectId: z.string().min(1).max(240),
          versionHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reload this Model.");
      return createHostedTrainingRunDetail({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
      }).savedModelServing(body.modelProjectId, { teamId, versionHash: body.versionHash });
    }
    if (action === "hosted_training_saved_model" || action === "hosted_training_saved_version") {
      const body = z
        .object({
          teamId: z.string().min(1),
          modelProjectId: z.string().min(1).max(240),
          preferActiveServing: z.boolean().optional(),
          versionHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reload this Model.");
      const detail = createHostedTrainingRunDetail({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
      });
      return action === "hosted_training_saved_version"
        ? detail.savedVersion(body.modelProjectId, body.versionHash, body.preferActiveServing)
        : detail.savedModel(body.modelProjectId);
    }
    if (
      [
        "hosted_training_detail",
        "hosted_training_result",
        "hosted_training_save_model",
        "hosted_training_flow",
        "hosted_training_summary",
        "hosted_training_logs",
        "hosted_training_feedback",
        "hosted_training_control",
      ].includes(action)
    ) {
      const body = z
        .object({
          teamId: z.string().min(1),
          jobId: z.string().min(1).max(200),
          includeFlow: z.boolean().optional(),
          feedbackTarget: RunFeedbackTargetSchema.optional(),
          action: z.enum(["start", "retry", "cancel"]).optional(),
          command: z.unknown().optional(),
        })
        .strict()
        .parse(payload);
      const [teamId, actorId, access] = await Promise.all([
        deps.teamId(),
        deps.actorId(),
        deps.resolveAccess(),
      ]);
      if (body.teamId !== teamId)
        throw new Error("The active workspace changed. Reload this training run.");
      const detail = createHostedTrainingRunDetail({
        teamId,
        actorId,
        access,
        currentIdentity: async () => ({
          teamId: await deps.teamId(),
          actorId: await deps.actorId(),
          apiOrigin: (await deps.resolveAccess()).apiBaseUrl,
        }),
      });
      return action === "hosted_training_detail"
        ? detail.read(body.jobId, { includeFlow: body.includeFlow })
        : action === "hosted_training_result"
          ? detail.result(body.jobId)
          : action === "hosted_training_save_model"
            ? detail.saveModel(body.jobId, body.command)
            : action === "hosted_training_flow"
              ? detail.readFlow(body.jobId)
              : action === "hosted_training_summary"
                ? detail.summary(body.jobId)
                : action === "hosted_training_logs"
                  ? detail.logs(body.jobId)
                  : action === "hosted_training_feedback"
                    ? detail.feedback(body.jobId, body.feedbackTarget)
                    : detail.control(
                        body.jobId,
                        z.enum(["start", "retry", "cancel"]).parse(body.action),
                        body.command,
                      );
    }
    return deps.trainingRequest(action, payload, requestUrl, signal);
  };
}
