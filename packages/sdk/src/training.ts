import { createWeightSpaceModelServingClient } from "./weight-space-model-serving.js";
export * from "./weight-space-model-serving.js";
import { createTrainingEvidenceClient } from "./training-evidence.js";
import { createWeightSpaceClient } from "./weight-space-sessions.js";
export * from "./weight-space-programming.js";
export * from "./weight-space-evaluation.js";
export * from "./weight-space-artifact.js";
export * from "./weight-space-sessions.js";
export { TrainingEvidenceWindowSchema, type TrainingEvidenceWindow } from "./training-evidence.js";
export * from "./training-usage-funding.js";
export * from "./managed-serving-usage.js";
export * from "./serverless-serving.js";
export * from "./managed-compute-price.js";
import { createEngramModelServingClient } from "./engram-model-serving.js";
export * from "./engram-model-serving.js";
import { createSteeringProfileClient } from "./steering-profile-publication.js";
export * from "./steering-profile-publication.js";
import { createExperimentDraftClient } from "./experiment-draft-storage.js";
import { createManagedModificationExecutionClient } from "./managed-modification-executions.js";
import { createManagedEngramExecutionClient } from "./managed-engram-executions.js";
import { createManagedDecisionExecutionClient } from "./managed-decision-executions.js";
import { createManagedAlphaEditExecutionClient } from "./managed-alphaedit-executions.js";
import { createManagedNeuronTrainingExecutionClient } from "./managed-neuron-training-executions.js";
import { createWeightModelClient } from "./weight-model-versions.js";
import { createAlphaEditModelServingClient } from "./alphaedit-model-serving.js";
import { createNeuronTrainingModelServingClient } from "./neuron-training-model-serving.js";
import { createDecisionModelClient } from "./decision-model-version.js";
import { createDecisionModelScoringClient } from "./decision-model-scoring.js";
import { createDecisionModelServingClient } from "./decision-model-serving.js";
import { createEngramModelClient } from "./engram-model-version.js";
export * from "./managed-engram-executions.js";
export * from "./decision-model.js";
export * from "./decision-model-data.js";
export * from "./decision-model-artifact.js";
export * from "./decision-model-training.js";
export * from "./decision-experiment-draft.js";
export * from "./decision-experiment-authoring.js";
export * from "./managed-decision-executions.js";
export * from "./decision-model-version.js";
export * from "./decision-model-scoring.js";
export * from "./decision-model-serving.js";
export * from "./alphaedit.js";
export * from "./alphaedit-artifact.js";
export * from "./alphaedit-experiment-draft.js";
export * from "./managed-alphaedit-executions.js";
export * from "./neuron-training.js";
export * from "./neuron-training-artifact.js";
export * from "./neuron-training-result.js";
export * from "./neuron-training-experiment-draft.js";
export * from "./managed-neuron-training-executions.js";
export * from "./weight-model-versions.js";
export * from "./weight-experiment-authoring.js";
export * from "./weight-inference.js";
export * from "./alphaedit-model-serving.js";
export * from "./neuron-training-model-serving.js";
export * from "./engram-inference.js";
export * from "./engram-model-version.js";
export * from "./engram-experiment-authoring.js";
export * from "./experiment-draft-storage.js";
import { createTrainingExecutionClient } from "./training-executions.js";
export { TrainingExecutionSummarySchema, TrainingExecutionPageSchema, TrainingExecutionListQuerySchema, type TrainingExecutionSummary, type TrainingExecutionPage, type TrainingExecutionListQuery } from "./training-executions.js";
import { createTrainingRequest } from "./training-transport.js";
export { SftRecipeSchema, ManagedSftRecipeSchema, TrainingSftImageCapabilitiesSchema,
  supportsTrainingSftRecipe, type SftRecipe, type TrainingSftImageCapabilities } from "./training-supervised.js";
export { TrainingApiErrorSchema, OpenPondTrainingApiError } from "./training-transport.js";
import { createTrainingAcceptanceClient } from "./training-acceptance.js";
import { createTrainingHardwareClient } from "./training-hardware.js";
export { HardwareObservationSchema, HardwareFleetSnapshotSchema,
  HardwareAvailabilitySchema, HardwareGpuObservationSchema,
  type HardwareObservation, type HardwareFleetSnapshot, type HardwareObservationQuery } from "./training-hardware.js";
import { createPostTrainingClient } from "./post-training.js";
export {
  TrainingAcceptanceGroupReferenceSchema,
  TrainingAcceptanceGroupSummarySchema,
  TrainingAcceptanceGroupPageSchema,
  TrainingAcceptanceGroupQuerySchema,
  type TrainingAcceptanceGroupReference,
  type TrainingAcceptanceGroupSummary,
  type TrainingAcceptanceGroupPage,
  type TrainingAcceptanceGroupQuery,
  type TrainingAcceptanceTarget,
} from "./training-acceptance.js";
import { z } from "zod";
import { TrainingCheckpointRecoveryRequestSchema } from "./training-recovery.js";
export { TrainingCheckpointRecoveryRequestSchema, TrainingCheckpointRecoveryResourceApprovalSchema,
  createTrainingCheckpointRecoveryResourceApproval } from "./training-recovery.js";
export { TrainingPhysicalPlacementSchema, type TrainingPhysicalPlacement } from "./training-physical-placement.js";
import { createTrainingPreparationClient } from "./training-preparations.js";
import { createTrainingExperimentLearningClient } from "./training-experiment-learning.js";
export * from "./training-experiment-learning.js";
import { createTrainingExperimentSetupClient } from "./training-experiment-setup.js";
export {
  TrainingExperimentSetupRequestSchema, TrainingExperimentSetupReceiptSchema,
  TrainingExperimentInputsPageSchema, type TrainingExperimentInputsPage,
  parseAndVerifyTrainingExperimentSetupReceipt, trainingExperimentConfigurationIdentity,
  type TrainingExperimentSetupRequest, type TrainingExperimentSetupReceipt,
} from "./training-experiment-setup.js";
import { createTrainingEstimateClient } from "./training-estimates.js";
import { createTrainingFundingClient } from "./training-funding.js";
export * from "./training-funding.js";
import { createDatasetTrainingReviewClient } from "./dataset-training-review.js";
import { createTrainingResultClient } from "./training-result.js";
import { createTrainingModelSaveClient } from "./training-model-save.js";
import { createTrainingModelServingClient } from "./training-model-serving.js";
export * from "./training-model-serving.js";
import { createTrainingModelServingControlClient } from "./training-model-serving-control.js";
export * from "./training-model-serving-control.js";
import { createSavedModelServingClient } from "./steering-model-serving.js";
export * from "./steering-model-serving.js";
export * from "./steering-inference.js";
export * from "./neuron-residual-calibration.js";
import { createNeuronCalibrationClient } from "./neuron-calibration-records.js";
export * from "./neuron-calibration-records.js";
export * from "./neuron-steering.js";
export * from "./activation-result-comparison.js";
export * from "./activation-reference.js";
export * from "./engram-adapter.js";
export * from "./engram-experiment-draft.js";
import { createModelModificationCapabilitiesClient } from "./model-modification-capabilities.js";
export * from "./model-modification-capabilities.js";
import { createModificationRecordingsClient } from "./modification-recordings.js";
export * from "./modification-recordings.js";
export * from "./training-model-save.js";
export * from "./training-result.js";
export * from "./experiment-result-reference.js";
export * from "./dataset-training-review.js";
import { createTrainingGpuCatalogClient } from "./training-compute-selection.js";
import { createTrainingHardwareCatalogClient } from "./training-hardware-catalog.js";
export * from "./training-hardware-catalog.js";
export { TrainingGpuCatalogSchema, TrainingGpuCatalogQuerySchema, TrainingGpuCatalogScopeSchema,
  parseAndVerifyTrainingGpuCatalog, type TrainingGpuCatalog, type TrainingGpuCatalogQuery, type TrainingGpuCatalogScope } from "./training-compute-selection.js";
export { TrainingQueueStatusSchema, type TrainingQueueStatus } from "./training-queue.js";
export {
  TrainingGpuSelectionSchema,
  TrainingEstimateSourceSchema,
  TrainingEstimateRequestSchema,
  TrainingEstimateComponentSchema,
  TrainingEstimateReviewSchema,
  TrainingEstimateSchema,
  TrainingEstimateWorkloadSchema,
  trainingEstimateSourceIdentity,
  type TrainingGpuSelection,
  type TrainingEstimateRequest,
  type TrainingEstimate,
  type TrainingEstimateWorkload,
  type TrainingEstimateReview,
} from "./training-estimates.js";
export {
  TrainingPreparationParentSchema,
  type TrainingPreparationParent,
  TrainingPreparationRequestSchema,
  TrainingPreparationPlanContentSchema,
  TrainingPreparationPlanSchema,
  TrainingPreparationReceiptSchema,
  TrainingPreparationControlSchema,
  TrainingSftQualificationPreparationImportSchema,
  parseAndVerifyTrainingPreparationReceipt,
  type TrainingPreparationRequest,
  type TrainingPreparationPlan,
  type TrainingPreparationReceipt,
  type TrainingPreparationControl,
  type TrainingSftQualificationPreparationImport,
} from "./training-preparations.js";
export {
  TrainingPreparationListQuerySchema,
  TrainingPreparationPageSchema,
  type TrainingPreparationListQuery,
  type TrainingPreparationPage,
} from "./training-preparations.js";
import { createTrainingHarnessSourceClient } from "./training-harness-sources.js";
export { TrainingHarnessSourcePublicationSchema } from "./training-harness-sources.js";
import { createTrainingCandidateDecisionClient } from "./training-candidate-decisions.js";
export {
  TrainingCandidateDecisionRequestSchema,
  TrainingCandidateDecisionSchema,
  trainingCandidateDecisionHash,
  parseAndVerifyTrainingCandidateDecision,
  type TrainingCandidateDecisionRequest,
  type TrainingCandidateDecision,
  type TrainingCandidateDecisionTarget,
} from "./training-candidate-decisions.js";
import { parseAndVerifyTrainingEvaluationTaskPage } from "./training-evaluation-results.js";

export { deterministicTrainingRewardSource } from "./training-grading-plan.js";
export {
  TRAINING_EVALUATION_SOURCE_PATH,
  TrainingEvaluationSourceSchema,
  assertTrainingEvaluationIsolation,
  trainingEvaluationSourceRef,
  type TrainingEvaluationSource,
} from "./training-evaluation-source.js";
export {
  TrainingEvaluationTaskResultSchema,
  TrainingEvaluationTaskPageSchema,
  trainingEvaluationTaskPageHash,
  parseAndVerifyTrainingEvaluationTaskPage,
  type TrainingEvaluationTaskResult,
  type TrainingEvaluationTaskPage,
} from "./training-evaluation-results.js";

import { ModelProjectImmutableRefSchema } from "./model-projects.js";
import { OpenPondProtocolError, canonicalSha256 } from "./protocol.js";

export {
  OPENPOND_TRAINING_MEDIA_TYPE,
  OPENPOND_TRAINING_PROTOCOL_MAJOR,
  TRAINING_API_RESPONSE_MAX_BYTES,
  TRAINING_INPUT_ARTIFACT_MAX_BYTES,
  TRAINING_JOB_SUBMISSION_MAX_BYTES,
  OpenPondProtocolError,
  assertCanonicalPayloadSize,
  canonicalJson,
  canonicalJsonByteLength,
  canonicalSha256,
  parseBoundedJson,
} from "./protocol.js";

import {
  TrainingCapabilitiesSchema, TrainingInputArtifactSchema, TrainingJobSchema, TrainingJobPageSchema,
  TrainingJobControlRequestSchema, TrainingJobOutputsSchema,
  parseAndVerifyTrainingInputArtifactUpload, parseAndVerifyTrainingJobSubmission,
  type TrainingInputArtifactUpload, type TrainingJobSubmission,
} from "./training-job-contracts.js";
export * from "./training-job-contracts.js";
export * from "./training-usage-status.js";

const IdSchema = z.string().trim().min(1).max(500);

export function createTrainingClient(input: {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}) {
  const request = createTrainingRequest(input);

  return {
    postTraining: createPostTrainingClient({ request }),
    ...createTrainingEvidenceClient(request),
    ...createWeightSpaceClient(request),
    ...createWeightSpaceModelServingClient(request),
    ...createTrainingPreparationClient(request),
    ...createTrainingExperimentSetupClient(request),
    ...createTrainingExperimentLearningClient(request),
    ...createTrainingEstimateClient(request),
    ...createTrainingFundingClient(request),
    ...createDatasetTrainingReviewClient(request),
    ...createTrainingResultClient(request),
    ...createTrainingModelSaveClient(request),
    ...createSteeringProfileClient(request),
    ...createTrainingModelServingClient(request),
    ...createTrainingModelServingControlClient(request),
    ...createSavedModelServingClient(request),
    ...createEngramModelServingClient(request),
    ...createNeuronCalibrationClient(request),
    ...createTrainingAcceptanceClient(request),
    ...createTrainingHardwareClient(request),
    ...createTrainingHardwareCatalogClient(request),
    ...createTrainingGpuCatalogClient(request),
    ...createModelModificationCapabilitiesClient(request),
    ...createModificationRecordingsClient(request),
    ...createTrainingHarnessSourceClient(request),
    ...createTrainingCandidateDecisionClient(request),
    ...createTrainingExecutionClient(request),
    ...createExperimentDraftClient(request),
    ...createManagedModificationExecutionClient(request),
    ...createManagedEngramExecutionClient(request),
    ...createManagedDecisionExecutionClient(request),
    ...createManagedAlphaEditExecutionClient(request),
    ...createManagedNeuronTrainingExecutionClient(request),
    ...createWeightModelClient(request),
    ...createAlphaEditModelServingClient(request),
    ...createNeuronTrainingModelServingClient(request),
    ...createDecisionModelClient(request),
    ...createDecisionModelScoringClient(request),
    ...createDecisionModelServingClient(request),
    ...createEngramModelClient(request),
    async capabilities() {
      return TrainingCapabilitiesSchema.parse(
        unwrapObject(await request("/v1/training/capabilities"), "capabilities"),
      );
    },
    async stageArtifact(upload: TrainingInputArtifactUpload) {
      const parsed = await parseAndVerifyTrainingInputArtifactUpload(upload);
      return TrainingInputArtifactSchema.parse(
        unwrapObject(
          await request("/v1/training/artifacts", {
            method: "POST",
            body: JSON.stringify(parsed),
          }),
          "artifact",
        ),
      );
    },
    async createJob(submission: TrainingJobSubmission) {
      const parsed = await parseAndVerifyTrainingJobSubmission(submission);
      return TrainingJobSchema.parse(
        unwrapObject(
          await request("/v1/training/jobs", {
            method: "POST",
            body: JSON.stringify(parsed),
          }),
          "job",
        ),
      );
    },
    async listJobs(
      options: {
        modelProjectId?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ) {
      const parameters = new URLSearchParams();
      if (options.modelProjectId) {
        parameters.set("modelProjectId", IdSchema.parse(options.modelProjectId));
      }
      if (options.cursor) {
        parameters.set("cursor", z.string().trim().min(1).max(2_000).parse(options.cursor));
      }
      if (options.limit !== undefined) {
        parameters.set("limit", String(z.number().int().min(1).max(1_000).parse(options.limit)));
      }
      const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
      return TrainingJobPageSchema.parse(await request(`/v1/training/jobs${query}`));
    },
    async getJob(jobId: string) {
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(`/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}`),
          "job",
        ),
      );
    },
    async cancelJob(jobId: string, expectedVersion: number) {
      const control = TrainingJobControlRequestSchema.parse({ expectedVersion });
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(`/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/cancel`, {
            method: "POST",
            body: JSON.stringify(control),
          }),
          "job",
        ),
      );
    },
    async stopAfterGroup(jobId: string, expectedVersion: number) {
      const control = TrainingJobControlRequestSchema.parse({ expectedVersion });
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(
            `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/stop-after-group`,
            { method: "POST", body: JSON.stringify(control) },
          ),
          "job",
        ),
      );
    },
    async recoverCheckpoint(jobId: string, input: z.input<typeof TrainingCheckpointRecoveryRequestSchema>) {
      const recovery = TrainingCheckpointRecoveryRequestSchema.parse(input);
      if (recovery.resourceApproval) {
        const { approvalHash, ...body } = recovery.resourceApproval;
        if (body.sourceJobId !== jobId || await canonicalSha256(body) !== approvalHash)
          throw new OpenPondProtocolError("content_hash_mismatch", "Recovery resource approval does not bind this source request.");
      }
      return TrainingJobSchema.parse(unwrapObject(await request(
        `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/recover`,
        { method: "POST", body: JSON.stringify(recovery) },
      ), "job"));
    },
    async outputs(jobId: string) {
      return TrainingJobOutputsSchema.parse(
        await request(`/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/outputs`),
      );
    },
    async evaluationTasks(
      jobId: string,
      evaluation: { id: string; contentHash: string },
      options: { cursor?: string; limit?: number } = {},
    ) {
      const id = IdSchema.parse(jobId);
      const reference = ModelProjectImmutableRefSchema.parse(evaluation);
      const parameters = new URLSearchParams();
      const cursor =
        options.cursor === undefined
          ? undefined
          : z
              .string()
              .regex(/^[1-9]\d*$/)
              .parse(options.cursor);
      const offset =
        cursor === undefined ? 0 : z.number().int().min(1).max(9_999).parse(Number(cursor));
      if (cursor !== undefined) parameters.set("cursor", cursor);
      if (options.limit !== undefined)
        parameters.set("limit", String(z.number().int().min(1).max(100).parse(options.limit)));
      const query = parameters.size ? `?${parameters.toString()}` : "";
      return parseAndVerifyTrainingEvaluationTaskPage(
        await request(
          `/v1/training/jobs/${encodeURIComponent(id)}/evaluations/${encodeURIComponent(reference.id)}/tasks${query}`,
        ),
        { jobId: id, evaluation: reference, offset },
      );
    },

  };
}

function unwrapObject(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return key in value ? (value as Record<string, unknown>)[key] : value;
}

export { ExperimentDraftSchema, ModelSetupDraftSchema, assertModelSetupExecutionIntent, parseAndVerifyExperimentDraft, ExperimentOperationTypeSchema, ExperimentStartingModelSchema, parseAndVerifyExperimentStartingModel, experimentOperationLabel, type ExperimentDraft, type ModelSetupDraft, type ExperimentOperationType, type ExperimentStartingModel } from "./training-experiment-setup.js";
export * from "./activation-experiment-draft.js";

export { TrainingExperimentFormDraftSchema, ExperimentDraftUpdateSchema, type TrainingExperimentFormDraft, type ExperimentDraftUpdate } from "./training-experiment-setup.js";
export * from "./evaluation-experiment-draft.js";
export * from "./managed-modification-executions.js";
export * from "./activation-form-compiler.js";

export { parseAndVerifyTrainingEstimate } from "./training-estimates.js";

export * from "./steering-experiment-source.js";
export * from "./steering-experiment-source-verification.js";
export * from "./steering-experiment-authoring.js";
