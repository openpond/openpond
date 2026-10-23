import { AttachPostTrainingSchema, PostTrainingControlSchema } from "openpond-sdk/post-training";
import { z } from "zod";
import {
  ModelInitialLearningSchema,
  ModelProjectSaveRequestSchema,
  HostedModelProjectSyncSchema,
} from "openpond-sdk/model-projects";
import {
  TrainingInputArtifactUploadSchema,
  TrainingPreparationRequestSchema,
  TrainingPreparationControlSchema,
  TrainingPreparationListQuerySchema,
  TrainingEstimateRequestSchema,
  TrainingJobSubmissionSchema,
  TrainingJobControlRequestSchema,
  TrainingCheckpointRecoveryRequestSchema,
  TrainingAcceptanceGroupQuerySchema,
  TrainingAcceptanceGroupReferenceSchema,
  TrainingCandidateDecisionRequestSchema,
} from "openpond-sdk/training";
import type { AddTool } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, Empty, Id, Ref, Window, page } from "./common.js";

export function addTraining(add: AddTool, c: Clients, teamId: string) {
  add(
    "models_list",
    "List hosted Model configurations and exact lineage in this workspace.",
    Empty,
    "read",
    () => c.models.list(),
  );
  add(
    "models_get",
    "Read a Model's pinned configuration, readiness and source revision.",
    ById,
    "read",
    (v) => c.models.get(v.id),
  );
  add(
    "models_configuration_candidates",
    "Read supported base-model configuration candidates.",
    Empty,
    "read",
    () => c.models.configurationCandidates(),
  );
  add(
    "models_check_configuration",
    "Validate an exact Model configuration without saving or training.",
    ModelProjectSaveRequestSchema,
    "write",
    (v) => c.models.checkConfiguration(v),
  );
  add(
    "models_save_configuration",
    "Save the requested Model configuration with its expected revision and source identity.",
    ModelProjectSaveRequestSchema.safeExtend({ learning: z.never().optional() }),
    "write",
    (v) => c.models.saveConfiguration(v),
  );
  add(
    "models_create_with_learning",
    "Create a Model with its explicitly bounded initial continual learning policy. Authorizes later scheduled training only under the reviewed policy limits.",
    ModelProjectSaveRequestSchema.safeExtend({ learning: ModelInitialLearningSchema }),
    "learning",
    (v) => c.models.saveConfiguration(v),
    { scopes: ["app:write", "app:learning"] },
  );
  add(
    "models_sync",
    "Synchronize portable Model source using the existing ETag/source revision contract; accepts JSON, never a local path.",
    HostedModelProjectSyncSchema,
    "write",
    (v) => c.models.upsert(v),
  );
  add(
    "training_capabilities",
    "Inspect hosted Ponder training readiness and supported methods without launching compute.",
    Empty,
    "read",
    () => c.training.capabilities(),
  );
  add(
    "training_estimate",
    "Estimate the exact approved training configuration and return the existing review/expiry identity.",
    TrainingEstimateRequestSchema,
    "write",
    (v) => c.training.estimate(v),
  );
  add(
    "training_preparations_list",
    "Discover retained Ponder preparations without creating a training job.",
    TrainingPreparationListQuerySchema,
    "read",
    (v) => c.training.listPreparations(teamId, v),
  );
  add(
    "training_prepare",
    "Prepare immutable Ponder training inputs. Preserve operation ID, pinned releases and explicit resource approval; does not start the job.",
    TrainingPreparationRequestSchema,
    "write",
    (v) => c.training.prepareRun(v),
  );
  add(
    "training_preparation_get",
    "Inspect the exact preparation receipt, plan hash and state.",
    ById,
    "read",
    (v) => c.training.getPreparation(teamId, v.id),
  );
  add(
    "training_preparation_start",
    "Start the explicitly approved Ponder plan using its unchanged planHash and retained operation identity. May incur the approved spend.",
    TrainingPreparationControlSchema.extend({ id: Id }),
    "execute",
    ({ id, ...v }) => c.training.startPreparation(id, v),
  );
  add(
    "training_preparation_cancel",
    "Cancel a retained preparation pinned to its approved plan hash.",
    TrainingPreparationControlSchema.extend({ id: Id }),
    "cancel",
    ({ id, ...v }) => c.training.cancelPreparation(id, v),
  );
  add(
    "training_artifacts_stage",
    "Stage authorized training input bytes using the existing hash-verified upload contract. This never reads a caller's local filesystem.",
    TrainingInputArtifactUploadSchema,
    "write",
    (v) => c.training.stageArtifact(v),
  );
  add(
    "training_jobs_create",
    "Submit a verified immutable Ponder training job with the existing explicit approval and resource budget. Reuse its submission identity after uncertain delivery.",
    TrainingJobSubmissionSchema,
    "execute",
    (v) => c.training.createJob(v),
  );
  add(
    "training_jobs_list",
    "List bounded hosted Ponder runs, optionally for one Model.",
    z
      .object({
        modelProjectId: Id.optional(),
        cursor: Id.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .strict(),
    "read",
    (v) => c.training.listJobs(v),
  );
  add(
    "training_jobs_get",
    "Read actual training lifecycle, cleanup state, version and retained evidence references.",
    ById,
    "read",
    (v) => c.training.getJob(v.id),
  );
  add(
    "training_jobs_cancel",
    "Explicitly cancel a job using the latest expected version. Read-back reports actual cleanup/lifecycle.",
    TrainingJobControlRequestSchema.extend({ id: Id }),
    "cancel",
    (v) => c.training.cancelJob(v.id, v.expectedVersion),
  );
  add(
    "training_jobs_stop_after_group",
    "Request a graceful stop after the current accepted group using compare-and-swap version control.",
    TrainingJobControlRequestSchema.extend({ id: Id }),
    "cancel",
    (v) => c.training.stopAfterGroup(v.id, v.expectedVersion),
  );
  add(
    "training_jobs_recover_checkpoint",
    "Recover a checkpoint only under its existing source identity, expected version and explicit resource approval; may launch approved work.",
    z.object({ id: Id, request: TrainingCheckpointRecoveryRequestSchema }).strict(),
    "execute",
    (v) => c.training.recoverCheckpoint(v.id, v.request),
  );
  add(
    "training_jobs_events",
    "Read a bounded window of retained run events. nextOffset follows append-only history; this does not watch or restart work.",
    Window.extend({ id: Id }),
    "read",
    async (v) => page(await c.training.events(v.id), v.after, v.limit),
  );
  add(
    "training_jobs_logs",
    "Read a bounded window of retained run logs.",
    Window.extend({ id: Id }),
    "read",
    async (v) => page(await c.training.logs(v.id), v.after, v.limit),
  );
  add(
    "training_jobs_outputs",
    "Read authorized retained training outputs, artifact references and receipts.",
    ById,
    "read",
    (v) => c.training.outputs(v.id),
  );
  add(
    "training_evaluation_tasks",
    "Read paginated held-out evaluation results for an exact retained evaluation reference.",
    z
      .object({
        jobId: Id,
        evaluation: Ref,
        cursor: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .strict(),
    "read",
    ({ jobId, evaluation, ...v }) => c.training.evaluationTasks(jobId, evaluation, v),
  );
  add(
    "training_acceptance_groups",
    "List retained candidate acceptance groups; never dispatch new checks.",
    TrainingAcceptanceGroupQuerySchema.extend({ jobId: Id }),
    "read",
    ({ jobId, ...v }) => c.training.acceptanceGroups({ teamId, jobId }, v),
  );
  add(
    "training_acceptance_group",
    "Inspect an exact acceptance snapshot and its pinned manifest/evidence.",
    z
      .object({
        jobId: Id,
        groupId: Id,
        expected: TrainingAcceptanceGroupReferenceSchema.optional(),
      })
      .strict(),
    "read",
    (v) => c.training.acceptanceGroup({ teamId, jobId: v.jobId }, v.groupId, v.expected),
  );
  add(
    "training_candidate_decision_get",
    "Read the current or exact retained candidate review decision; this does not activate serving.",
    z.object({ jobId: Id, artifact: Ref, decision: Ref.optional() }).strict(),
    "read",
    (v) =>
      c.training.candidateDecision(
        { teamId, jobId: v.jobId, artifact: v.artifact },
        { decision: v.decision },
      ),
  );
  add(
    "training_post_evaluation_attach",
    "Attach an exact bounded post-training evaluation plan. Automatic execution may spend within the explicitly approved plan ceiling.",
    AttachPostTrainingSchema,
    "execute",
    (v) => c.training.postTraining.attach(teamId, v),
  );
  add(
    "training_post_evaluation_get",
    "Read the retained post-training evaluation summary for one job.",
    ById,
    "read",
    (v) => c.training.postTraining.get(teamId, v.id),
  );
  for (const action of ["start", "retry", "cancel"] as const) {
    add(
      `training_post_evaluation_${action}`,
      `Apply ${action} only to the exact retained post-training evaluation plan and expected revision; never reruns model training.`,
      PostTrainingControlSchema.extend({ id: Id }),
      action === "cancel" ? "cancel" : "execute",
      ({ id, ...v }) => c.training.postTraining.control(teamId, id, action, v),
    );
  }
  add(
    "training_candidate_decision_record",
    "Record an authorized candidate review against exact evidence and predecessor decision. Review never implicitly activates serving.",
    TrainingCandidateDecisionRequestSchema,
    "review",
    (v) => c.training.recordCandidateDecision(v),
  );
}
