import { z } from "zod";
import {
  TOOL_LEARNING_LIMITS,
  ToolEpisodeEventSchema,
  ToolLearningIdSchema,
  ToolLearningInstallationSchema,
  ToolLearningScopeSchema,
} from "@openpond/evals/tool-learning";
import { LearningSourceCredentialSecretSchema } from "./learning-credentials.js";
import { ToolLearningEpisodeAssemblySchema } from "./tool-learning-episodes.js";

/** Shared wire envelopes used by native clients and the Python schema exporter. */
export const ToolLearningRegistrationReceiptSchema = z
  .object({
    installation: ToolLearningInstallationSchema,
    apiKey: LearningSourceCredentialSecretSchema,
  })
  .strict();

export const ToolLearningInstallationPageSchema = z
  .object({
    items: z.array(ToolLearningInstallationSchema).max(30),
    nextCursor: ToolLearningIdSchema.nullable(),
  })
  .strict();

export const ToolLearningEpisodePageSchema = z
  .object({
    installationId: ToolLearningIdSchema,
    scope: ToolLearningScopeSchema,
    items: z
      .array(
        z
          .object({
            episodeId: ToolLearningIdSchema,
            eventCount: z.number().int().positive(),
            lastReceivedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(30),
    nextCursor: ToolLearningIdSchema.nullable(),
    learningEnrollment: z.literal(false),
  })
  .strict();

export const ToolLearningEpisodeDetailSchema = z
  .object({
    installationId: ToolLearningIdSchema,
    episodeId: ToolLearningIdSchema,
    scope: ToolLearningScopeSchema,
    events: z.array(ToolEpisodeEventSchema).max(TOOL_LEARNING_LIMITS.eventsPerEpisode),
    state: ToolLearningEpisodeAssemblySchema.shape.state,
    assembly: ToolLearningEpisodeAssemblySchema,
    verificationAuthority: z.literal("not_granted"),
    learningEnrollment: z.literal(false),
  })
  .strict();

export const ToolLearningPurgeRequestSchema = z
  .object({
    operationId: ToolLearningIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const ToolLearningPurgeReceiptSchema = z
  .object({
    installationId: ToolLearningIdSchema,
    operationId: ToolLearningIdSchema,
    purgedEvents: z.number().int().nonnegative(),
    learningEnrollment: z.literal(false),
  })
  .strict();
