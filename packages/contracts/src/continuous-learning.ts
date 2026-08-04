import { z } from "zod";

export const GET_CONVERSATIONS_TOOL_NAME = "get_conversations" as const;
export const GET_CONVERSATIONS_CONTRACT_VERSION =
  "openpond.getConversations.v1" as const;
export const CONTINUOUS_LEARNING_RECOMMENDATION_CONTRACT_VERSION =
  "openpond.continuousLearningRecommendation.v1" as const;
export const CONTINUOUS_LEARNING_RECEIPT_CONTRACT_VERSION =
  "openpond.continuousLearningReceipt.v1" as const;
export const MAX_REVIEW_CONVERSATION_CANDIDATES = 3;
export const MAX_REVIEW_CONVERSATION_SOURCE_REFERENCES = 12;
export const MAX_REVIEW_CONVERSATIONS = 12;
export const MAX_REVIEW_CONVERSATION_MESSAGES = 16;
export const CONTINUOUS_LEARNING_TEMPLATE_KEY =
  "openpond.continuous-learning-review.v1" as const;
export const CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT_VERSION =
  "openpond.continuous-learning-review-prompt.v2" as const;
export const CONTINUOUS_LEARNING_DEFAULT_POLICY_VERSION =
  "openpond.continuous-learning-policy.v1" as const;
export const CONTINUOUS_LEARNING_DEFAULT_POLICY = {
  cadence: {
    kind: "daily",
    localTime: "02:00",
  },
  lookbackDays: 30,
  model: {
    provider: "openpond",
    model: "openpond-chat",
    reasoningEffort: "high",
  },
  limits: {
    maxConversations: 12,
    maxMessagesPerConversation: 16,
    maxEvidenceTokens: 48_000,
    maxOutputTokens: 4_000,
    maxDurationMs: 300_000,
    maxCostUsd: 1,
  },
} as const;
export const CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT = [
  "Review the bounded Work-first evidence for recurring, verifiable opportunities to improve future model behavior.",
  "Call get_conversations exactly once. Its Work and chat lanes, scope, consent, watermark, and budgets are already configured for this Work item.",
  "Use verified Work as the strongest outcome evidence, successful Work next, failed Work only for discovery, and chat only as recurrence context. Recommend at most three next actions: Taskset, Skill, prompting, retrieval, or no action.",
  "Cite only returned source reference IDs. Treat feedback as recommendation evidence, never as reward. Do not request other conversation, trace, file, browser, shell, connected-app, or workspace access.",
  "Write a concise human-readable recommendation, then append exactly one <openpond-continuous-learning-recommendation> JSON object </openpond-continuous-learning-recommendation>. The JSON must contain schemaVersion openpond.continuousLearningRecommendation.v1, the configured scope, recommendations, and noRecommendationReason. Each recommendation must contain candidateFingerprint, title, summary, rationale, proposedAction, and at least three returned sourceReferenceIds.",
  "Stop after writing the recommendation. Do not materialize a Taskset or start an Evaluation, training Run, Model Version, deployment, or binding.",
].join("\n\n");

const IdSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().trim().min(1).max(100);
const FingerprintSchema = z.string().trim().min(1).max(512);
const WatermarkSchema = z.string().trim().min(1).max(1_000);

export const ContinuousLearningScopeSchema = z.enum(["personal", "my_team"]);
export const ContinuousLearningUiScopeSchema = z.enum([
  "personal",
  "my_team",
  "full_team",
]);

export const CONTINUOUS_LEARNING_SCOPE_OPTIONS = [
  {
    value: "personal",
    enabled: true,
    label: "Personal",
    description: "Review eligible conversations you created in Personal.",
  },
  {
    value: "my_team",
    enabled: true,
    label: "My Team",
    description: "Review eligible conversations you created in this Team.",
  },
  {
    value: "full_team",
    enabled: false,
    label: "Full Team",
    description: "Coming later — requires a Team consent policy.",
  },
] as const satisfies readonly {
  value: z.infer<typeof ContinuousLearningUiScopeSchema>;
  enabled: boolean;
  label: string;
  description: string;
}[];

/**
 * This is the complete model-callable argument contract. Owner, workspace,
 * source, watermark, schedule, run, and budget identity are runtime bindings.
 */
export const GetConversationsToolInputSchema = z.object({}).strict();

export const ReviewConversationSourceReferenceSchema = z
  .object({
    referenceId: IdSchema,
    surface: z.enum(["desktop", "hosted"]),
    scope: ContinuousLearningScopeSchema,
    experience: z.enum(["chat", "work", "development"]),
    revision: z.string().trim().min(1).max(512),
    occurredAt: TimestampSchema,
    contentHash: z.string().trim().min(1).max(512),
  })
  .strict();

export const ReviewConversationMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "action"]),
    text: z.string().trim().min(1).max(2_000),
    createdAt: TimestampSchema,
  })
  .strict();

export const ReviewConversationSchema = z
  .object({
    sourceReference: ReviewConversationSourceReferenceSchema,
    title: z.string().trim().min(1).max(240).nullable(),
    messages: z
      .array(ReviewConversationMessageSchema)
      .min(1)
      .max(MAX_REVIEW_CONVERSATION_MESSAGES),
  })
  .strict();

export const ReviewConversationsEmptyReasonSchema = z.enum([
  "no_eligible_sources",
  "privacy_or_consent_filtered",
  "budget_exhausted",
]);

export const ContinuousLearningNoRecommendationReasonSchema = z.enum([
  "no_eligible_sources",
  "insufficient_recurrence",
  "privacy_or_consent_filtered",
  "dismissed_patterns",
  "budget_exhausted",
  "no_actionable_pattern",
]);

export const ReviewConversationExcludedCountsSchema = z
  .object({
    notEligible: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
    notCreatedByOwner: z.number().int().nonnegative(),
    multiParticipant: z.number().int().nonnegative(),
    outsideLookback: z.number().int().nonnegative(),
    dismissedFingerprint: z.number().int().nonnegative(),
    budgetBound: z.number().int().nonnegative(),
  })
  .strict();

export const GetConversationsToolResultSchema = z
  .object({
    schemaVersion: z.literal(GET_CONVERSATIONS_CONTRACT_VERSION),
    scope: ContinuousLearningScopeSchema,
    inputWatermark: WatermarkSchema.nullable(),
    proposedWatermark: WatermarkSchema,
    consideredSourceCount: z.number().int().nonnegative(),
    excludedCounts: ReviewConversationExcludedCountsSchema,
    conversations: z
      .array(ReviewConversationSchema)
      .max(MAX_REVIEW_CONVERSATIONS),
    emptyReason: ReviewConversationsEmptyReasonSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.conversations.length === 0 && result.emptyReason === null) {
      context.addIssue({
        code: "custom",
        message: "emptyReason is required when no conversations are returned",
        path: ["emptyReason"],
      });
    }
    if (result.conversations.length > 0 && result.emptyReason !== null) {
      context.addIssue({
        code: "custom",
        message: "emptyReason must be null when conversations are returned",
        path: ["emptyReason"],
      });
    }
    const referenceIds = result.conversations.map(
      (conversation) => conversation.sourceReference.referenceId,
    );
    if (new Set(referenceIds).size !== referenceIds.length) {
      context.addIssue({
        code: "custom",
        message: "conversation source references must be unique",
        path: ["conversations"],
      });
    }
    result.conversations.forEach((conversation, conversationIndex) => {
      if (conversation.sourceReference.scope !== result.scope) {
        context.addIssue({
          code: "custom",
          message:
            "conversation source scope must match the configured review scope",
          path: [
            "conversations",
            conversationIndex,
            "sourceReference",
            "scope",
          ],
        });
      }
    });
  });

export const ContinuousLearningRecommendationActionSchema = z.enum([
  "taskset",
  "skill",
  "prompting",
  "retrieval",
  "no_action",
]);

export const ContinuousLearningRecommendationSchema = z
  .object({
    candidateFingerprint: FingerprintSchema,
    title: z.string().trim().min(1).max(240),
    summary: z.string().trim().min(1).max(2_000),
    rationale: z.string().trim().min(1).max(2_000),
    proposedAction: ContinuousLearningRecommendationActionSchema,
    sourceReferenceIds: z
      .array(IdSchema)
      .min(3)
      .max(MAX_REVIEW_CONVERSATION_SOURCE_REFERENCES),
  })
  .strict();

export const ContinuousLearningRecommendationOutputSchema = z
  .object({
    schemaVersion: z.literal(
      CONTINUOUS_LEARNING_RECOMMENDATION_CONTRACT_VERSION,
    ),
    scope: ContinuousLearningScopeSchema,
    recommendations: z
      .array(ContinuousLearningRecommendationSchema)
      .max(MAX_REVIEW_CONVERSATION_CANDIDATES),
    noRecommendationReason:
      ContinuousLearningNoRecommendationReasonSchema.nullable(),
  })
  .strict()
  .superRefine((output, context) => {
    if (
      output.recommendations.length === 0 &&
      output.noRecommendationReason === null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "noRecommendationReason is required when no recommendations are emitted",
        path: ["noRecommendationReason"],
      });
    }
    if (
      output.recommendations.length > 0 &&
      output.noRecommendationReason !== null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "noRecommendationReason must be null when recommendations are emitted",
        path: ["noRecommendationReason"],
      });
    }
  });

export const ContinuousLearningRunStatusSchema = z.enum([
  "completed",
  "no_recommendation",
  "failed",
  "cancelled",
]);

export const ContinuousLearningReceiptSchema = z
  .object({
    schemaVersion: z.literal(CONTINUOUS_LEARNING_RECEIPT_CONTRACT_VERSION),
    surface: z.enum(["desktop", "hosted"]),
    scope: ContinuousLearningScopeSchema,
    scheduleDefinitionRef: IdSchema,
    runRef: IdSchema,
    promptVersion: IdSchema,
    skill: z
      .object({
        name: IdSchema,
        artifactVersion: IdSchema,
        contentHash: z.string().trim().min(1).max(512),
      })
      .strict(),
    evidenceContractVersion: z.union([
      z.literal(GET_CONVERSATIONS_CONTRACT_VERSION),
      z.literal("openpond.learningEvidenceView.v1"),
    ]),
    inputWatermark: WatermarkSchema.nullable(),
    outputWatermark: WatermarkSchema.nullable(),
    consideredSourceCount: z.number().int().nonnegative(),
    excludedCounts: ReviewConversationExcludedCountsSchema,
    evidenceLaneCounts: z
      .object({
        work: z
          .object({
            considered: z.number().int().nonnegative(),
            excluded: z.number().int().nonnegative(),
            selected: z.number().int().nonnegative(),
            revoked: z.number().int().nonnegative(),
          })
          .strict(),
        chat: z
          .object({
            considered: z.number().int().nonnegative(),
            excluded: z.number().int().nonnegative(),
            selected: z.number().int().nonnegative(),
            revoked: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict()
      .nullable()
      .default(null),
    selectedSourceReferences: z
      .array(ReviewConversationSourceReferenceSchema)
      .max(
        MAX_REVIEW_CONVERSATION_CANDIDATES *
          MAX_REVIEW_CONVERSATION_SOURCE_REFERENCES,
      ),
    candidateFingerprints: z
      .array(FingerprintSchema)
      .max(MAX_REVIEW_CONVERSATION_CANDIDATES),
    recommendationSummaries: z
      .array(
        z
          .object({
            candidateFingerprint: FingerprintSchema,
            proposedAction: ContinuousLearningRecommendationActionSchema,
            summary: z.string().trim().min(1).max(2_000),
          })
          .strict(),
      )
      .max(MAX_REVIEW_CONVERSATION_CANDIDATES),
    model: z
      .object({
        provider: IdSchema,
        model: IdSchema,
      })
      .strict(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
      })
      .strict(),
    status: ContinuousLearningRunStatusSchema,
    noRecommendationReason:
      ContinuousLearningNoRecommendationReasonSchema.nullable(),
    materializationInvoked: z.literal(false),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const committed =
      receipt.status === "completed" ||
      receipt.status === "no_recommendation";
    if (committed && receipt.outputWatermark === null) {
      context.addIssue({
        code: "custom",
        message: "successful receipts require an output watermark",
        path: ["outputWatermark"],
      });
    }
    if (!committed && receipt.outputWatermark !== null) {
      context.addIssue({
        code: "custom",
        message: "failed and cancelled receipts cannot advance the watermark",
        path: ["outputWatermark"],
      });
    }
    if (
      receipt.status === "completed" &&
      receipt.recommendationSummaries.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "completed receipts require at least one recommendation",
        path: ["recommendationSummaries"],
      });
    }
    if (
      receipt.status === "no_recommendation" &&
      receipt.noRecommendationReason === null
    ) {
      context.addIssue({
        code: "custom",
        message: "no-recommendation receipts require a reason",
        path: ["noRecommendationReason"],
      });
    }
  });

export type ContinuousLearningScope = z.infer<
  typeof ContinuousLearningScopeSchema
>;
export type ContinuousLearningUiScope = z.infer<
  typeof ContinuousLearningUiScopeSchema
>;
export type GetConversationsToolInput = z.infer<
  typeof GetConversationsToolInputSchema
>;
export type ReviewConversationSourceReference = z.infer<
  typeof ReviewConversationSourceReferenceSchema
>;
export type ReviewConversationMessage = z.infer<
  typeof ReviewConversationMessageSchema
>;
export type ReviewConversation = z.infer<
  typeof ReviewConversationSchema
>;
export type GetConversationsToolResult = z.infer<
  typeof GetConversationsToolResultSchema
>;
export type ReviewConversationsEmptyReason = z.infer<
  typeof ReviewConversationsEmptyReasonSchema
>;
export type ContinuousLearningNoRecommendationReason = z.infer<
  typeof ContinuousLearningNoRecommendationReasonSchema
>;
export type ContinuousLearningRecommendationAction = z.infer<
  typeof ContinuousLearningRecommendationActionSchema
>;
export type ContinuousLearningRecommendation = z.infer<
  typeof ContinuousLearningRecommendationSchema
>;
export type ContinuousLearningRecommendationOutput = z.infer<
  typeof ContinuousLearningRecommendationOutputSchema
>;
export type ContinuousLearningRunStatus = z.infer<
  typeof ContinuousLearningRunStatusSchema
>;
export type ContinuousLearningReceipt = z.infer<
  typeof ContinuousLearningReceiptSchema
>;

export const LocalConversationLearningConsentSchema = z
  .object({
    schemaVersion: z.literal("openpond.localConversationLearningConsent.v1"),
    status: z.enum(["granted", "revoked"]),
    scope: ContinuousLearningScopeSchema,
    workspaceId: IdSchema.nullable(),
    grantedAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();

export const LocalContinuousLearningDefinitionSchema = z
  .object({
    schemaVersion: z.literal("openpond.localSavedWorkDefinition.v1"),
    id: IdSchema,
    profileId: IdSchema,
    scope: ContinuousLearningScopeSchema,
    workspaceId: IdSchema.nullable(),
    templateKey: z.literal(CONTINUOUS_LEARNING_TEMPLATE_KEY),
    version: z.number().int().positive(),
    promptVersion: z.literal(
      CONTINUOUS_LEARNING_RECOMMENDATION_PROMPT_VERSION,
    ),
    prompt: z.string().trim().min(1).max(20_000),
    policyVersion: z.literal(CONTINUOUS_LEARNING_DEFAULT_POLICY_VERSION),
    skill: z
      .object({
        name: z.literal("openpond-taskset-authoring"),
        artifactVersion: IdSchema,
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    model: z
      .object({
        provider: IdSchema,
        model: IdSchema,
        reasoningEffort: z.enum(["low", "medium", "high"]),
      })
      .strict(),
    limits: z
      .object({
        lookbackDays: z.number().int().positive().max(365),
        maxConversations: z.number().int().positive().max(100),
        maxMessagesPerConversation: z.number().int().positive().max(100),
        maxEvidenceTokens: z.number().int().positive().max(1_000_000),
        maxOutputTokens: z.number().int().positive().max(100_000),
        maxDurationMs: z.number().int().positive().max(3_600_000),
        maxCostUsd: z.number().nonnegative().max(100),
      })
      .strict(),
    createdAt: TimestampSchema,
  })
  .strict();

export const LocalContinuousLearningScheduleSchema = z
  .object({
    schemaVersion: z.literal("openpond.localSavedWorkSchedule.v1"),
    id: IdSchema,
    definitionId: IdSchema,
    enabled: z.boolean(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: IdSchema,
    nextRunAt: TimestampSchema.nullable(),
    lastRunAt: TimestampSchema.nullable(),
    lastRunStatus: ContinuousLearningRunStatusSchema.nullable(),
    latestResultSessionId: IdSchema.nullable(),
    inputWatermark: WatermarkSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const LocalContinuousLearningRunSchema = z
  .object({
    schemaVersion: z.literal("openpond.localSavedWorkRun.v1"),
    id: IdSchema,
    scheduleId: IdSchema,
    definitionId: IdSchema,
    trigger: z.enum(["schedule", "manual"]),
    status: z.enum([
      "queued",
      "running",
      "completed",
      "no_recommendation",
      "failed",
      "cancelled",
    ]),
    scheduledFor: TimestampSchema,
    sessionId: IdSchema.nullable(),
    receipt: ContinuousLearningReceiptSchema.nullable(),
    error: z.string().trim().min(1).max(4_000).nullable(),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .strict();

export const LocalContinuousLearningStateSchema = z
  .object({
    schemaVersion: z.literal("openpond.localContinuousLearningState.v1"),
    id: IdSchema,
    profileId: IdSchema,
    scope: ContinuousLearningScopeSchema,
    workspaceId: IdSchema.nullable(),
    definitions: z.array(LocalContinuousLearningDefinitionSchema).min(1),
    currentDefinitionId: IdSchema,
    schedule: LocalContinuousLearningScheduleSchema,
    runs: z.array(LocalContinuousLearningRunSchema).max(50),
    onboardingDecision: z.enum(["unseen", "enabled", "dismissed"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (!state.definitions.some((item) => item.id === state.currentDefinitionId)) {
      context.addIssue({
        code: "custom",
        message: "currentDefinitionId must reference an immutable definition",
        path: ["currentDefinitionId"],
      });
    }
    if (state.schedule.definitionId !== state.currentDefinitionId) {
      context.addIssue({
        code: "custom",
        message: "schedule must reference the current definition",
        path: ["schedule", "definitionId"],
      });
    }
  });

export const EnsureLocalContinuousLearningRequestSchema = z
  .object({
    profileId: IdSchema,
    scope: ContinuousLearningScopeSchema.default("personal"),
    workspaceId: IdSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    timezone: IdSchema.optional(),
    onboardingDecision: z.enum(["unseen", "enabled", "dismissed"]).optional(),
    model: z
      .object({
        provider: IdSchema,
        model: IdSchema,
        reasoningEffort: z.enum(["low", "medium", "high"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PatchLocalContinuousLearningRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    timezone: IdSchema.optional(),
    onboardingDecision: z.enum(["unseen", "enabled", "dismissed"]).optional(),
    model: z
      .object({
        provider: IdSchema,
        model: IdSchema,
        reasoningEffort: z.enum(["low", "medium", "high"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SetLocalConversationLearningConsentRequestSchema = z
  .object({
    status: z.enum(["granted", "revoked"]),
    scope: ContinuousLearningScopeSchema.default("personal"),
    workspaceId: IdSchema.nullable().optional(),
  })
  .strict();

export type LocalConversationLearningConsent = z.infer<
  typeof LocalConversationLearningConsentSchema
>;
export type LocalContinuousLearningDefinition = z.infer<
  typeof LocalContinuousLearningDefinitionSchema
>;
export type LocalContinuousLearningSchedule = z.infer<
  typeof LocalContinuousLearningScheduleSchema
>;
export type LocalContinuousLearningRun = z.infer<
  typeof LocalContinuousLearningRunSchema
>;
export type LocalContinuousLearningState = z.infer<
  typeof LocalContinuousLearningStateSchema
>;
export type EnsureLocalContinuousLearningRequest = z.infer<
  typeof EnsureLocalContinuousLearningRequestSchema
>;
export type PatchLocalContinuousLearningRequest = z.infer<
  typeof PatchLocalContinuousLearningRequestSchema
>;
export type SetLocalConversationLearningConsentRequest = z.infer<
  typeof SetLocalConversationLearningConsentRequestSchema
>;
