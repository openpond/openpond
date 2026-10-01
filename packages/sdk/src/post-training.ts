import { z } from "zod";
import { contentHash } from "@openpond/harness";
import {
  LearningSourceSchema,
  TaskBatchSchema,
  TaskDefinitionSchema,
  LearningPolicySchema,
  LearningPolicyInspectionResultSchema,
  LearningIterationSchema,
} from "@openpond/evals/learning";
import { HostedModelProjectSummarySchema } from "./model-projects.js";
import { AcceptancePlanSchema } from "@openpond/evals/learning";
import { TrainingHandoffOriginSchema } from "@openpond/evals/learning";
export { TrainingHandoffOriginSchema, type TrainingHandoffOrigin } from "@openpond/evals/learning";
import { RunExperimentSchema } from "./experiment-run-contracts.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.object({ id: Id, contentHash: Hash }).strict();
export const TrainingHandoffContextSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().max(1000).nullable(),
    origin: TrainingHandoffOriginSchema.nullable(),
  })
  .strict();
export type TrainingHandoffContext = z.infer<typeof TrainingHandoffContextSchema>;
export const PostTrainingAttachmentSchema = z
  .object({
    schemaVersion: z.literal("openpond.postTrainingAttachment.v1"),
    binding: z
      .object({
        kind: z.enum(["preparation", "policy"]),
        id: Id,
        revision: z.number().int().positive(),
        contentHash: Hash,
      })
      .strict(),
    projectId: Id.nullable(),
    automatic: z.boolean(),
    maximumSpendUsd: z.number().finite().positive().max(10_000),
    experiments: z
      .array(z.object({ id: Id, configuration: RunExperimentSchema }).strict())
      .min(1)
      .max(20),
    acceptancePlan: AcceptancePlanSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.experiments.map((item) => item.id)).size !== value.experiments.length)
      ctx.addIssue({ code: "custom", message: "Attach each evaluation once." });
    if (
      value.experiments.reduce((sum, item) => sum + item.configuration.maximumCostUsd, 0) >
      value.maximumSpendUsd + 1e-9
    )
      ctx.addIssue({
        code: "custom",
        message: "Attached evaluation budgets exceed the total approved budget.",
      });
    if (
      value.experiments.some(
        (item) => (item.configuration.request.project?.id ?? null) !== value.projectId,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Attached experiments must use the training Project.",
      });
    if (value.acceptancePlan) {
      const checked = new Set(value.acceptancePlan.checks.map((c) => c.id));
      if (value.acceptancePlan.checks.some((c) => !value.experiments.some((m) => m.id === c.id)))
        ctx.addIssue({
          code: "custom",
          message: "Select the frozen Experiment for each acceptance check.",
        });
      const committed =
        value.acceptancePlan.maximumSpendUsd +
        value.experiments
          .filter((m) => !checked.has(m.id))
          .reduce((sum, m) => sum + m.configuration.maximumCostUsd, 0);
      if (committed > value.maximumSpendUsd + 1e-9)
        ctx.addIssue({
          code: "custom",
          message:
            "Paired acceptance and diagnostic ceilings exceed the approved evaluation budget.",
        });
    }
  });
export type PostTrainingAttachment = z.infer<typeof PostTrainingAttachmentSchema>;
/** Target-independent recipe pins keep the paired baseline/candidate check on
 * the same released data, case order, settings and graders. */
export function postTrainingRecipe(
  configuration: PostTrainingAttachment["experiments"][number]["configuration"],
) {
  const {
    modelId: _model,
    candidate: _candidate,
    ...settings
  } = configuration.request.policy.kind === "fixture"
    ? { modelId: null, candidate: null, ...configuration.request.policy }
    : configuration.request.policy;
  void _model;
  void _candidate;
  if ("modelConfigurationHash" in settings)
    delete (settings as { modelConfigurationHash?: string }).modelConfigurationHash;
  return {
    dataset: {
      id: configuration.request.taskset.id,
      contentHash: configuration.request.taskset.contentHash,
    },
    populationHash: contentHash(
      configuration.request.population.map((m) => ({
        caseId: m.taskId,
        seed: m.seed,
        fixtureId: m.fixtureId,
      })),
    ),
    executionHash: contentHash({ settings, graders: configuration.graders ?? null }),
  };
}
export const PostTrainingQualificationSchema = z
  .object({
    baseline: Ref,
    checks: z
      .array(
        z
          .object({
            id: Id,
            sourceRunId: Id,
            sourceManifestHash: Hash,
            targetConfigurationHash: Hash,
            executionHash: Hash,
            populationHash: Hash,
            evaluator: Ref,
            feedbackKey: Id,
            output: z.enum(["boolean", "score"]),
            unit: z.string().min(1).max(80),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const PostTrainingStateSchema = z.enum([
  "waiting_for_training",
  "ready",
  "preparing",
  "queued",
  "running",
  "cleaning",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "budget_exhausted",
]);
export const PostTrainingSummarySchema = z
  .object({
    schemaVersion: z.literal("openpond.postTrainingSummary.v1"),
    id: Id,
    teamId: Id,
    jobId: Id,
    revision: z.number().int().positive(),
    planHash: Hash,
    automatic: z.boolean(),
    candidate: Ref.nullable(),
    state: PostTrainingStateSchema,
    total: z.number().int().positive(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    requiredOutcome: z.enum(["none", "pending", "passed", "failed", "blocked"]),
    reason: z.string().max(500).nullable(),
    groupId: Id.nullable(),
    experimentIds: z.array(Id).max(20),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.completed + value.failed > value.total)
      ctx.addIssue({ code: "custom", message: "Evaluation totals are inconsistent." });
    if (
      ["preparing", "queued", "running", "cleaning", "completed"].includes(value.state) &&
      !value.candidate
    )
      ctx.addIssue({
        code: "custom",
        message: "Evaluation execution requires the exact trained candidate.",
      });
  });
export type PostTrainingSummary = z.infer<typeof PostTrainingSummarySchema>;
export const PostTrainingControlSchema = z
  .object({ operationId: Id, expectedRevision: z.number().int().positive(), planHash: Hash })
  .strict();
export const AttachPostTrainingSchema = z
  .object({ operationId: Id, attachment: PostTrainingAttachmentSchema })
  .strict();
export const PostTrainingPlanSchema = z
  .object({
    id: Id,
    teamId: Id,
    ownerUserId: Id,
    attachment: PostTrainingAttachmentSchema,
    qualification: PostTrainingQualificationSchema.nullable(),
    contentHash: Hash,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PostTrainingPlan = z.infer<typeof PostTrainingPlanSchema>;
export function verifyPostTrainingPlan(raw: unknown): PostTrainingPlan {
  const plan = PostTrainingPlanSchema.parse(raw);
  if (
    plan.contentHash !==
    contentHash({ attachment: plan.attachment, qualification: plan.qualification })
  )
    throw new Error("The retained evaluation attachment or qualification changed.");
  return plan;
}
export function postTrainingActive(summary: PostTrainingSummary | null | undefined) {
  return Boolean(summary && ["preparing", "queued", "running", "cleaning"].includes(summary.state));
}

/** Read/setup are configuration-only. Manual start authorizes exactly the
 * retained candidate, plan and revision. A retry never launches training. */
export function createPostTrainingClient(input: {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
}) {
  const { request } = input;
  const path = (jobId: string) =>
    `/v1/training/jobs/${encodeURIComponent(Id.parse(jobId))}/post-training`;
  async function read(raw: unknown, teamId: string, jobId: string) {
    if (raw === null) return null;
    const value = PostTrainingSummarySchema.parse(raw);
    if (value.teamId !== teamId || value.jobId !== jobId)
      throw new OpenPondProtocolError(
        "post_training_scope_mismatch",
        "The evaluation summary belongs to another run or workspace.",
      );
    return value;
  }
  return {
    async attach(teamId: string, raw: z.input<typeof AttachPostTrainingSchema>) {
      const body = AttachPostTrainingSchema.parse(raw);
      const value = verifyPostTrainingPlan(
        await request("/v1/training/post-training-plans", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      if (
        value.teamId !== teamId ||
        (await canonicalSha256(value.attachment)) !== (await canonicalSha256(body.attachment))
      )
        throw new OpenPondProtocolError(
          "post_training_plan_mismatch",
          "The retained attachment differs from the reviewed plan.",
        );
      return value;
    },
    async get(teamId: string, jobId: string) {
      return read(await request(path(jobId)), teamId, jobId);
    },
    async control(
      teamId: string,
      jobId: string,
      action: "start" | "retry" | "cancel",
      raw: z.input<typeof PostTrainingControlSchema>,
    ) {
      const body = PostTrainingControlSchema.parse(raw);
      const value = await read(
        await request(`${path(jobId)}/${action}`, { method: "POST", body: JSON.stringify(body) }),
        teamId,
        jobId,
      );
      if (!value || value.planHash !== body.planHash)
        throw new OpenPondProtocolError(
          "post_training_control_mismatch",
          "Evaluation control did not retain the approved plan.",
        );
      return value;
    },
  };
}

export const HostedTrainingSetupCatalogSchema = z
  .object({
    teamId: Id,
    actorId: Id,
    projectId: Id.nullable(),
    configuration: HostedModelProjectSummarySchema,
    batches: z.array(TaskBatchSchema).max(10_000),
    sources: z.array(LearningSourceSchema).max(10_000),
    definitions: z.array(TaskDefinitionSchema).max(10_000),
    experiments: z
      .array(
        z
          .object({
            id: Id,
            name: z.string().max(500),
            configuration: RunExperimentSchema,
            graders: z
              .array(z.object({ feedbackKey: Id, name: z.string().max(500), ref: Ref }).strict())
              .max(100),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();
export type HostedTrainingSetupCatalog = z.infer<typeof HostedTrainingSetupCatalogSchema>;

export const HostedTrainingSetupActionSchema = z.enum([
  "prepare",
  "start",
  "cancel",
  "publish",
  "attach",
]);
export type HostedTrainingSetupAction = z.infer<typeof HostedTrainingSetupActionSchema>;

export const HostedTrainingPolicyDetailSchema = z
  .object({
    teamId: Id,
    actorId: Id,
    configuration: HostedModelProjectSummarySchema,
    policy: LearningPolicySchema,
    inspection: LearningPolicyInspectionResultSchema,
    iterations: z
      .array(
        z
          .object({
            iteration: LearningIterationSchema,
            evals: PostTrainingSummarySchema.nullable(),
          })
          .strict(),
      )
      .max(100),
    nextCursor: Id.nullable(),
  })
  .strict();
export const HostedTrainingPolicyControlSchema = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    policyHash: Hash,
    operationId: Id,
    action: z.enum(["pause", "resume", "reserve", "cancel-iteration", "retry-iteration"]),
    iterationId: Id.optional(),
    iterationRevision: z.number().int().positive().optional(),
  })
  .strict();
export type HostedTrainingPolicyControl = z.infer<typeof HostedTrainingPolicyControlSchema>;
