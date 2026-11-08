import { z } from "zod";
import {
  ExperimentDraftSchema,
  ExperimentDraftSaveSchema,
  ExperimentDraftArchiveSchema,
  ExperimentDraftListQuerySchema,
  ExperimentDraftRecordSchema,
  ExperimentDraftReceiptSchema,
  ExperimentDraftPageSchema,
  TrainingExperimentSetupRequestSchema,
  TrainingExecutionListQuerySchema,
  TrainingFundingRequestSchema,
  TrainingFundingHandoffRequestSchema,
  TrainingFundingSchema,
  TrainingFundingHandoffSchema,
  TrainingResultSchema,
  TrainingResultSaveRequestSchema,
  TrainingSavedModelSchema,
  DatasetTrainingReviewRequestSchema,
  TrainingExperimentLearningRequestSchema,
  TrainingExperimentLearningReceiptSchema,
} from "openpond-sdk/training";
import {
  DatasetTaskAppendRequestSchema,
  DatasetTaskAppendReceiptSchema,
} from "openpond-sdk/dataset-workspaces";
import type { Clients } from "./clients.js";
import type { AddTool, OpenPondMcpContext } from "./types.js";
import { ById, Id, verifyPrincipal, withoutWorkspace } from "./common.js";

export function addTrainingWorkflows(add: AddTool, c: Clients, context: OpenPondMcpContext) {
  const teamId = context.teamId;
  // Compact discovery envelopes avoid repeating the complete form/schema on
  // every read. The SDK verifies the full, unchanged document and its hashes.
  const draftIdentity = z
    .object({ id: Id, teamId: Id, revision: z.number().int().positive() })
    .passthrough();
  const draftReceipt = z
    .object({ operationId: Id, requestHash: z.string(), record: draftIdentity })
    .passthrough();
  const draftPage = z
    .object({ teamId: Id, items: z.array(draftIdentity), nextCursor: z.string().nullable() })
    .passthrough();
  const authoringDraft = ExperimentDraftSchema.safeExtend({
    operationType: z.enum([
      "evaluate",
      "sft",
      "grpo",
      "engram_adapter",
      "decision_model",
      "selective_neuron_training",
    ]),
    activationForm: z.never().optional(),
    alphaEditForm: z.never().optional(),
  });
  add(
    "experiment_drafts_list",
    "List your saved experiment drafts in the connected workspace. Saving a draft never starts work.",
    ExperimentDraftListQuerySchema,
    "read",
    async (v) => verifyPrincipal(await c.training.listExperimentDrafts(teamId, v), context),
    { output: ExperimentDraftPageSchema, wireOutput: draftPage },
  );
  add(
    "experiment_drafts_get",
    "Read your exact saved experiment draft, revision and verified source references.",
    ById,
    "read",
    async (v) => verifyPrincipal(await c.training.getExperimentDraft(teamId, v.id), context),
    { output: ExperimentDraftRecordSchema, wireOutput: draftIdentity },
  );
  add(
    "experiment_drafts_save",
    "Save an evaluation or supported training draft using its original operation ID and expected revision. This never prepares, trains or enables learning.",
    ExperimentDraftSaveSchema.omit({ teamId: true }).extend({ draft: authoringDraft }),
    "write",
    async (v) => {
      const result = await c.training.saveExperimentDraft({ ...v, teamId });
      verifyPrincipal(result.record, context);
      return result;
    },
    { output: ExperimentDraftReceiptSchema, wireOutput: draftReceipt, destructive: false },
  );
  add(
    "experiment_drafts_archive",
    "Archive your saved experiment draft at its expected revision. This never cancels an execution.",
    ExperimentDraftArchiveSchema.omit({ teamId: true }).extend({ id: Id }),
    "write",
    async ({ id, ...v }) => {
      const result = await c.training.archiveExperimentDraft(id, { ...v, teamId });
      verifyPrincipal(result.record, context);
      return result;
    },
    { output: ExperimentDraftReceiptSchema, wireOutput: draftReceipt },
  );
  add(
    "training_prepare_experiment",
    "Prepare an exact SFT or GRPO experiment through the canonical model-first setup service. Preserve the operation ID, source revisions and spend approval; this does not start training.",
    withoutWorkspace(TrainingExperimentSetupRequestSchema),
    "write",
    async (v) => {
      const result = await c.training.prepareExperiment({ ...v, teamId });
      if (result.preparation.plan.creatorUserId !== context.userId)
        throw new Error("Training preparation belongs to another principal.");
      return result;
    },
    { destructive: false },
  );
  add(
    "training_executions_list",
    "List retained ordinary training execution summaries with Project, Dataset and search filters. Method-specific adapter executions have separate lifecycles.",
    TrainingExecutionListQuerySchema,
    "read",
    (v) => c.training.listExecutions(teamId, v),
  );
  add(
    "training_save_learning_policy",
    "Save or pause this exact Model's bounded continual-learning policy from its training draft. Enabling a policy authorizes later scheduled work within its explicit limits; this does not start a manual run or activate serving.",
    withoutWorkspace(TrainingExperimentLearningRequestSchema),
    "learning",
    (v) => c.training.saveExperimentLearning({ ...v, teamId }),
    { scopes: ["app:write", "app:learning"], output: TrainingExperimentLearningReceiptSchema },
  );
  add(
    "training_funding_preview",
    "Check advisory funding coverage for an exact maximum spend and optional saved draft. Restricted members do not receive private balance totals. This reserves no credit and starts no work.",
    withoutWorkspace(TrainingFundingRequestSchema),
    "read",
    async (v) => verifyPrincipal(await c.training.funding({ ...v, teamId }), context),
    { output: TrainingFundingSchema },
  );
  add(
    "training_billing_handoff",
    "Create a permission-checked hosted Billing link for your exact saved draft and cap. The user completes any purchase in Billing; this tool makes no payment.",
    withoutWorkspace(TrainingFundingHandoffRequestSchema),
    "write",
    async (v) => verifyPrincipal(await c.training.fundingHandoff({ ...v, teamId }), context),
    { output: TrainingFundingHandoffSchema, destructive: false },
  );
  add(
    "training_jobs_result",
    "Read the verified training result, source lineage, candidate evidence and any saved Model version for an exact retained job.",
    ById,
    "read",
    (v) => c.training.result(v.id, { teamId }),
    { output: TrainingResultSchema },
  );
  add(
    "training_jobs_save_model",
    "Save an exact retained training candidate as a Model version using its artifact hash, checkpoint, submission identity and expected Model revision. This does not activate serving.",
    TrainingResultSaveRequestSchema.omit({ teamId: true }).extend({ jobId: Id }),
    "write",
    async ({ jobId, ...v }) =>
      verifyPrincipal(await c.training.saveResultModel(jobId, { ...v, teamId }), context),
    { destructive: false },
  );
  add(
    "models_saved_get",
    "Read an ordinary trained Model and its exact verified saved version. This never allocates serving capacity.",
    ById,
    "read",
    (v) => c.training.savedModel(v.id, { teamId }),
    { output: TrainingSavedModelSchema },
  );
  add(
    "datasets_add_task",
    "Append one bounded structured task to this Dataset using a stable source operation ID. Retained errors are evidence, not correct answers; saving never grants training permission or enables learning.",
    DatasetTaskAppendRequestSchema.extend({ datasetId: Id }),
    "write",
    (v) => c.datasets.addTask(v.datasetId, v.task, { idempotencyKey: v.operationId }),
    { output: DatasetTaskAppendReceiptSchema, idempotent: true, destructive: false },
  );
  add(
    "datasets_submit_training_review",
    "Submit exact published Dataset tasks through the canonical training-review boundary. Admission, sealed batches, learning enrollment and paid execution remain separate operations.",
    withoutWorkspace(DatasetTrainingReviewRequestSchema),
    "review",
    async (v) => verifyPrincipal(await c.training.reviewDataset({ ...v, teamId }), context),
    { destructive: false },
  );
}
