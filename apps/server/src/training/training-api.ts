import {
  BaseModelPreferenceSchema,
  ChatModelRefSchema,
  CodexReasoningEffortSchema,
  ApproveDatasetImportMappingRequestSchema,
  CreateHuggingFaceDatasetImportRequestSchema,
  DatasetCatalogResponseSchema,
  ModelProjectSchema,
  ModelRunDraftSchema,
  nextCreateImproveRunRevision,
  PatchTaskCandidateRequestSchema,
  RunTaskMinerRequestSchema,
  TaskCreationRequestSchema,
  TaskMinerConfigSchema,
  TasksetDraftSchema,
  TasksetOperationalStateSchema,
  TasksetSchema,
  TrainingDestinationIdSchema,
  TrainingChatSearchRequestSchema,
  type BaseModelPreference,
  type TaskCreationRequest,
  type TaskCreationSnapshot,
} from "@openpond/contracts";
import {
  createPreferenceComparisonRelease,
  PreferenceComparisonReleaseSchema,
  type ComparisonAssignmentCandidateInput,
  type HarnessCompatibilityReceipt,
  type PreferenceComparisonPurpose,
  type PreferenceComparisonRelease,
  type PreferenceReviewer,
  type TasksetRelease,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import {
  computeTasksetHash,
  createTasksetDraft,
  materializePortableTasksetRelease,
  publishTasksetDraft,
} from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import type { createTaskCreatorService } from "./task-creator.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createTaskMinerService } from "./task-miner.js";
import type { createTrainingService } from "./training-service.js";
import {
  MANAGED_REWARD_MODEL_PROFILE,
  managedSyntheticRewardSmokeRecipe,
} from "./managed-reward-model-recipes.js";
import type { createTrainingChatSearchService } from "./training-chat-search.js";
import type { createDatasetArtifactService } from "./dataset-artifact-service.js";
import type { createDatasetImportService } from "./dataset-imports/import-service.js";
import type { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import type { createHarnessRefinerBenchmarkService } from "./harness-refiner-benchmark-service.js";
import type { createPreferenceComparisonService } from "./preference-comparison-service.js";
import type { createModelProjectHostingService } from "./model-project-hosting.js";
import { trainingRunDetail } from "./run-detail.js";
import {
  materializeSyntheticCollectionRun,
  SyntheticCollectionRunRequestSchema,
} from "./synthetic-collection-run.js";
import {
  compileDesktopHarnessContext,
} from "./portable-evals-adapter.js";
import { persistCanonicalEvaluationEvidence } from "./canonical-evaluation-persistence.js";
import {
  advanceUnexecutedModelRunTasksetRef,
  createExistingTasksetModelCreateImproveRun,
  createTasksetAuthoringCreateImproveRun,
  createModelTrainingCreateImproveRun,
  failTasksetAuthoringCreateImproveRun,
  syncTasksetAuthoringCreateImproveRun,
} from "./model-create-improve.js";
import { attachModelTargetRefs } from "../runtime/create-pipeline/target-adapters.js";
import {
  createEvidenceSnapshot,
  createTasksetRef,
} from "./create-improve-taskset-lineage.js";
import { syncModelTrainingCreateImproveRuns } from "./model-create-improve-reconciliation.js";
import { legacyBaseModelPreference } from "./base-model-candidates.js";
import { projectTrainingActivity } from "./training-activity.js";
import {
  linkHarnessReviewTaskset,
  startHarnessReviewTasksetAuthoring,
} from "./harness-review-taskset.js";
import {
  qualifyHarnessModelImprovement,
  requireQualifiedModelImprovement,
} from "./harness-model-improvement.js";
import {
  harnessIntegerArray,
  nonnegativeHarnessNumber,
  optionalImmutableRef,
  recipeBaseModelId,
  requiredImmutableRef,
  sameImmutableRef,
} from "./harness-training-api-inputs.js";
import {
  loadBenchmarkHistory,
} from "./training-benchmark-state.js";
import {
  handleModelRunControl,
  isModelRunControlAction,
} from "./training-api-model-run-control.js";
import {
  runTasksetBenchmark,
  startHarnessRefinerBenchmark,
} from "./training-benchmark-actions.js";

type TaskCreator = ReturnType<typeof createTaskCreatorService>;
type TaskMiner = ReturnType<typeof createTaskMinerService>;
type Evaluation = ReturnType<typeof createTaskEvaluationService>;
type Training = ReturnType<typeof createTrainingService>;
type StartedTrainingResult = Awaited<ReturnType<Training["start"]>>;
type TrainingChatSearch = ReturnType<typeof createTrainingChatSearchService>;
type DatasetArtifacts = ReturnType<typeof createDatasetArtifactService>;
type DatasetImports = ReturnType<typeof createDatasetImportService>;
type BenchmarkTasksets = ReturnType<typeof createBenchmarkTasksetService>;
type HarnessRefinerBenchmarks = ReturnType<typeof createHarnessRefinerBenchmarkService>;
type PreferenceComparisons = ReturnType<typeof createPreferenceComparisonService>;

export function createTrainingApi(deps: {
  store: SqliteStore;
  storeDir: string;
  taskCreator: TaskCreator;
  taskMiner: TaskMiner;
  evaluation: Evaluation;
  training: Training;
  chatSearch: TrainingChatSearch;
  datasetArtifacts: DatasetArtifacts;
  datasetImports: DatasetImports;
  benchmarkTasksets: BenchmarkTasksets;
  harnessRefinerBenchmarks?: HarnessRefinerBenchmarks;
  preferenceComparisons?: PreferenceComparisons;
  modelProjectHosting?: ReturnType<typeof createModelProjectHostingService>;
}) {
  async function request(
    action: string,
    payload: unknown,
    requestUrl?: URL,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    const input = record(payload);
    if (action === "state") return state(string(input.profileId) ?? requestUrl?.searchParams.get("profileId") ?? "default");
    if (action === "activity") return activity(string(input.profileId) ?? requestUrl?.searchParams.get("profileId") ?? "default");
    if (action === "portable_catalog") {
      return deps.training.portableCatalog(
        requestUrl?.searchParams.get("query") ?? "",
        portableMethod(requestUrl?.searchParams.get("method")),
      );
    }
    if (action === "dataset_catalog") {
      return datasetCatalog(
        string(input.profileId)
          ?? requestUrl?.searchParams.get("profileId")
          ?? "default",
      );
    }
    if (action === "preference_comparison_list") {
      return deps.store.listPreferenceComparisonAssignments({
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
      });
    }
    if (action === "preference_comparison_calibration_status") {
      return requirePreferenceComparisons(deps.preferenceComparisons).calibrationStatus({
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        reviewerKey: requiredString(
          string(input.reviewerKey) ?? requestUrl?.searchParams.get("reviewerKey"),
          "reviewerKey",
        ),
        comparisonReleaseId:
          string(input.comparisonReleaseId)
          ?? requestUrl?.searchParams.get("comparisonReleaseId"),
      });
    }
    if (action === "preference_comparison_calibration_start") {
      const preferenceComparisons = requirePreferenceComparisons(deps.preferenceComparisons);
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const reviewerKey = requiredString(input.reviewerKey, "reviewerKey");
      const batchId = requiredString(input.id, "id");
      const rubric = requiredString(input.rubric, "rubric");
      const minimumSamples = optionalPositiveInteger(input.minimumSamples) ?? 10;
      const taskset = await requireTaskset(deps.store, tasksetId);
      const portable = materializePortableTasksetRelease({
        taskset,
        adapterId: "openpond-managed-calibration-v1",
      });
      const requestedTaskId = nullableString(input.taskId);
      const task = requestedTaskId
        ? taskset.tasks.find((candidate) => candidate.id === requestedTaskId) ?? null
        : taskset.tasks.find((candidate) => candidate.split === "validation")
          ?? taskset.tasks.find((candidate) => candidate.split === "train")
          ?? null;
      if (!task || task.split === "frozen_eval") {
        throw new Error("Preference calibration requires a train or validation Taskset task.");
      }
      const existing = (await deps.store.listPreferenceComparisonReleases(tasksetId)).find((record) =>
        record.release.tasksetRelease.id === portable.tasksetRelease.id
        && record.release.tasksetRelease.contentHash === portable.tasksetRelease.contentHash
        && record.release.rubricRef.contentHash === contentHash(rubric)
        && record.release.calibration.minimumSamples === minimumSamples,
      ) ?? null;
      const release = existing?.release ?? createPreferenceComparisonRelease({
        schemaVersion: "openpond.preferenceComparisonRelease.v1",
        id: `preference-comparison-${tasksetId}-r${taskset.revision}-${contentHash({ rubric, minimumSamples }).slice(0, 16)}`,
        revision: taskset.revision,
        tasksetRelease: {
          id: portable.tasksetRelease.id,
          contentHash: portable.tasksetRelease.contentHash,
        },
        candidateCount: 4,
        resultMode: "ordered_tie_groups",
        allowTies: true,
        allowRejectAll: true,
        presentation: {
          showTaskPrompt: true,
          randomizeCandidateOrder: true,
          hideModelIdentity: true,
          parts: [
            { source: "attempt_output", path: "/text", renderer: "markdown" },
            ...(task.expectedOutput?.artifactRenderer
              ? [{ source: "artifact" as const, path: "candidate-image-1.png", renderer: "image" as const }]
              : []),
          ],
        },
        rubricRef: {
          id: `preference-rubric-${contentHash(rubric).slice(0, 24)}`,
          contentHash: contentHash(rubric),
          mediaType: "text/markdown",
          sizeBytes: Buffer.byteLength(rubric),
        },
        criteria: [{ id: "overall_quality", label: "Overall quality", instruction: rubric, weight: 1 }],
        assignment: { strategy: "randomized_blinded_v1", maxAssignmentsPerCandidate: 20 },
        aggregation: { algorithm: "mean_pairwise_win_fraction_v1", quorum: 1, rejectAllThreshold: 1 },
        rewardProjection: { algorithm: "pairwise_win_fraction_v1", verifierId: "preference-quality", verifierVersion: "1", weight: 1 },
        calibration: {
          minimumSamples,
          minimumOrderAgreement: 0.8,
          minimumTieAgreement: 0.8,
          minimumOrderSwapAgreement: 0.8,
        },
        metadata: { source: "openpond-managed-calibration" },
      });
      if (!existing) {
        await preferenceComparisons.publishRelease({
          tasksetId,
          tasksetRelease: portable.tasksetRelease,
          release,
          publisherKey: reviewerKey,
        });
        await bindTasksetPreferenceComparison({ store: deps.store, taskset, release });
      }
      const policyTasks = taskset.tasks
        .filter((candidate) => candidate.split !== "frozen_eval")
        .map((candidate) => ({
          id: candidate.id,
          instruction: typeof candidate.input.prompt === "string" ? candidate.input.prompt : JSON.stringify(candidate.input),
          context: {
            ...candidate.policyVisibleContext,
            outputContract: taskset.metadata.tasksetOutputContract ?? null,
          },
          expectedText: null,
          artifactRenderer: candidate.expectedOutput?.artifactRenderer ?? null,
        }));
      if (policyTasks.length === 1) policyTasks.push({ ...policyTasks[0]! });
      const requestContent = {
        schemaVersion: "openpond.managedRlCalibrationBatchRequest.v1" as const,
        name: `Calibration · ${taskset.name}`.slice(0, 191),
        idempotencyKey: `openpond-calibration:${release.contentHash}:${contentHash([task.id, batchId])}`.slice(0, 191),
        taskId: task.id,
        tasks: policyTasks,
        tasksetRelease: portable.tasksetRelease,
        verifierSetRelease: portable.verifierSetRelease,
        comparisonRelease: release,
        maximumSpendUsd: 2,
      };
      return {
        release,
        ...(await deps.training.createPreferenceCalibrationBatch({
          ...requestContent,
          requestHash: contentHash(requestContent),
        })),
      };
    }
    if (action === "preference_comparison_calibration_sync") {
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const reviewerKey = requiredString(input.reviewerKey, "reviewerKey");
      const jobId = requiredString(input.jobId, "jobId");
      const result = await deps.training.preferenceCalibrationBatch(jobId);
      if (!result.batch) return result;
      return {
        ...result,
        assignment: await requirePreferenceComparisons(deps.preferenceComparisons).importManagedCalibrationBatch({
          tasksetId,
          importerKey: reviewerKey,
          batch: result.batch,
        }),
      };
    }
    if (action === "preference_comparison_publish") {
      const preferenceComparisons = requirePreferenceComparisons(deps.preferenceComparisons);
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const taskset = await requireTaskset(deps.store, tasksetId);
      const published = await preferenceComparisons.publishRelease({
        tasksetId,
        tasksetRelease: await requireReleasedTaskset(deps.benchmarkTasksets, taskset),
        release: PreferenceComparisonReleaseSchema.parse(input.release),
        publisherKey: requiredString(input.publisherKey, "publisherKey"),
        retentionUntil: nullableString(input.retentionUntil),
      });
      await bindTasksetPreferenceComparison({
        store: deps.store,
        taskset,
        release: published.release,
      });
      return published;
    }
    if (action === "preference_comparison_create_assignment") {
      const preferenceComparisons = requirePreferenceComparisons(deps.preferenceComparisons);
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      return preferenceComparisons.createAssignment({
        id: requiredString(input.id, "id"),
        tasksetId,
        comparisonReleaseId: requiredString(input.comparisonReleaseId, "comparisonReleaseId"),
        candidates: requiredRecordArray(input.candidates, "candidates") as ComparisonAssignmentCandidateInput[],
        harnessCompatibilityReceipts: optionalRecordArray(input.harnessCompatibilityReceipts) as HarnessCompatibilityReceipt[] | undefined,
        purpose: preferenceComparisonPurpose(input.purpose),
        presentedCandidateOrder: optionalStringArray(input.presentedCandidateOrder),
        creatorKey: requiredString(input.creatorKey, "creatorKey"),
      });
    }
    if (action === "preference_comparison_next") {
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const reviewerKey = requiredString(input.reviewerKey, "reviewerKey");
      const assignment = await requirePreferenceComparisons(deps.preferenceComparisons).nextAssignment({
        tasksetId,
        reviewerKey,
      });
      return assignment
        ? preferenceComparisonReviewPayload(deps.store, assignment, humanPreferenceReviewer(reviewerKey))
        : null;
    }
    if (action === "preference_comparison_submit") {
      const preferenceComparisons = requirePreferenceComparisons(deps.preferenceComparisons);
      const reviewerKey = requiredString(input.reviewerKey, "reviewerKey");
      const reviewer = input.reviewer
        ? preferenceReviewer(input.reviewer)
        : humanPreferenceReviewer(reviewerKey);
      return preferenceComparisons.submitHumanReceipt({
        id: requiredString(input.id, "id"),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        assignmentId: requiredString(input.assignmentId, "assignmentId"),
        reviewerKey,
        reviewer,
        order: requiredStringGroupArray(input.order, "order"),
        rejectAll: input.rejectAll === true,
        criterionScores: optionalScoreRecord(input.criterionScores),
        feedbackArtifactRef: optionalArtifactRef(input.feedbackArtifactRef),
        startedAt: requiredString(input.startedAt, "startedAt"),
      });
    }
    if (action === "preference_comparison_fixture_submit") {
      const labelerRelease = requiredImmutableRef(input.labelerRelease, "labelerRelease");
      const fixtureRelease = requiredImmutableRef(input.fixtureRelease, "fixtureRelease");
      return requirePreferenceComparisons(deps.preferenceComparisons).submitFixtureReceipt({
        id: requiredString(input.id, "id"),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        assignmentId: requiredString(input.assignmentId, "assignmentId"),
        actorKey: requiredString(input.actorKey, "actorKey"),
        labelerRelease,
        fixtureRelease,
        ratings: preferenceRatings(input.ratings),
        startedAt: requiredString(input.startedAt, "startedAt"),
      });
    }
    if (action === "preference_dataset_list") {
      return requirePreferenceComparisons(deps.preferenceComparisons).listPreferenceDatasets(
        requiredString(input.tasksetId, "tasksetId"),
      );
    }
    if (action === "preference_dataset_materialize") {
      return requirePreferenceComparisons(deps.preferenceComparisons).materializePreferenceDataset({
        id: requiredString(input.id, "id"),
        revision: boundedInteger(input.revision, "revision", 1, 1_000_000, 1),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        comparisonReleaseId: requiredString(input.comparisonReleaseId, "comparisonReleaseId"),
        authority: input.authority === "human" ? "human" : "synthetic_fixture",
        groups: requiredRecordArray(input.groups, "groups").map((group) => ({
          assignmentId: requiredString(group.assignmentId, "groups.assignmentId"),
          partition: preferenceDatasetPartition(group.partition),
        })),
        actorKey: requiredString(input.actorKey, "actorKey"),
      });
    }
    if (action === "reward_model_run_launch") {
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const datasetId = requiredString(input.preferenceDatasetReleaseId, "preferenceDatasetReleaseId");
      const taskset = await requireTaskset(deps.store, tasksetId);
      const dataset = (await requirePreferenceComparisons(deps.preferenceComparisons)
        .listPreferenceDatasets(tasksetId))
        .find((candidate) => candidate.id === datasetId);
      if (!dataset) throw new Error("Preference Dataset release was not found for this Taskset.");
      const comparisonRelease = await deps.store.getPreferenceComparisonRelease(
        dataset.comparisonRelease.id,
      );
      if (
        !comparisonRelease ||
        comparisonRelease.tasksetId !== tasksetId ||
        comparisonRelease.release.contentHash !== dataset.comparisonRelease.contentHash ||
        comparisonRelease.tasksetRelease.id !== dataset.tasksetRelease.id ||
        comparisonRelease.tasksetRelease.contentHash !== dataset.tasksetRelease.contentHash
      ) {
        throw new Error("Preference Dataset release does not resolve to its exact Taskset release.");
      }
      const recipe = managedSyntheticRewardSmokeRecipe({
        tasksetRelease: {
          id: dataset.tasksetRelease.id,
          contentHash: dataset.tasksetRelease.contentHash,
        },
        preferenceDatasetRelease: { id: dataset.id, contentHash: dataset.contentHash },
      });
      return deps.training.launchRewardModel({
        id: requiredString(input.id, "id"),
        rewardModelId: requiredString(input.rewardModelId, "rewardModelId"),
        taskset,
        tasksetRelease: comparisonRelease.tasksetRelease,
        dataset,
        recipe,
        managedBaseModel: MANAGED_REWARD_MODEL_PROFILE,
      });
    }
    if (action === "reward_model_qualification_retry") {
      return deps.training.retryRewardModelQualification(
        requiredString(input.runId, "runId"),
        requiredString(input.id, "id"),
      );
    }
    if (action === "learned_preference_reward_binding") {
      return deps.training.learnedPreferenceRewardBinding({
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        rewardModelVersionId: requiredString(input.rewardModelVersionId, "rewardModelVersionId"),
      });
    }
    if (action === "preference_comparison_model_review") {
      const actorKey = requiredString(input.reviewerKey, "reviewerKey");
      return requirePreferenceComparisons(deps.preferenceComparisons).submitModelReceipt({
        id: requiredString(input.id, "id"),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        assignmentId: requiredString(input.assignmentId, "assignmentId"),
        actorKey,
        model: ChatModelRefSchema.parse(input.model),
        rubric: requiredString(input.rubric, "rubric"),
        reviewVariant: preferenceModelReviewVariant(input.reviewVariant),
        signal,
      });
    }
    if (action === "preference_comparison_calibration_review_next") {
      return requirePreferenceComparisons(deps.preferenceComparisons).submitNextCalibrationModelReceipt({
        id: requiredString(input.id, "id"),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        comparisonReleaseId: nullableString(input.comparisonReleaseId),
        actorKey: requiredString(input.reviewerKey, "reviewerKey"),
        model: ChatModelRefSchema.parse(input.model),
        rubric: requiredString(input.rubric, "rubric"),
        signal,
      });
    }
    if (action === "preference_comparison_calibration_save") {
      return requirePreferenceComparisons(deps.preferenceComparisons).saveCalibrationFromStoredReceipts({
        id: requiredString(input.id, "id"),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        comparisonReleaseId: requiredString(input.comparisonReleaseId, "comparisonReleaseId"),
        reviewerKey: requiredString(input.reviewerKey, "reviewerKey"),
        model: ChatModelRefSchema.parse(input.model),
      });
    }
    if (action === "preference_comparison_unreviewable") {
      return requirePreferenceComparisons(deps.preferenceComparisons).markUnreviewable({
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        assignmentId: requiredString(input.assignmentId, "assignmentId"),
        reviewerKey: requiredString(input.reviewerKey, "reviewerKey"),
        reason: requiredString(input.reason, "reason"),
      });
    }
    if (action === "run_taskset_benchmark") {
      return runTasksetBenchmark(deps.evaluation, input);
    }
    if (action === "start_harness_refiner_benchmark") {
      return startHarnessRefinerBenchmark(deps.harnessRefinerBenchmarks, input);
    }
    if (action === "sync_model_project") {
      if (!deps.modelProjectHosting) {
        throw new Error("Hosted Model Project sync is unavailable.");
      }
      return deps.modelProjectHosting.syncProject(
        requiredString(input.modelId, "modelId"),
      );
    }
    if (action === "publish_model_project_taskset") {
      if (!deps.modelProjectHosting) {
        throw new Error("Hosted Model Project sync is unavailable.");
      }
      const taskset = await requireTaskset(
        deps.store,
        requiredString(input.tasksetId, "tasksetId"),
      );
      const release = await requireReleasedTaskset(
        deps.benchmarkTasksets,
        taskset,
      );
      return deps.modelProjectHosting.publishTaskset({
        projectId: requiredString(input.modelId, "modelId"),
        taskset,
        release,
      });
    }
    if (action === "save_model_project") {
      const project = ModelProjectSchema.parse(input);
      const existing = await deps.store.getModelProject(project.id);
      if (existing && existing.profileId !== project.profileId) {
        throw new Error("Model profile does not match the active Profile.");
      }
      if (existing && existing.revision !== project.revision) {
        throw new Error("Model Project changed since it was opened. Refresh and try again.");
      }
      return deps.store.saveModelProject({
        ...project,
        revision: existing ? existing.revision + 1 : project.revision,
        createdAt: existing?.createdAt ?? project.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    if (action === "save_model_run_draft") {
      const draft = ModelRunDraftSchema.parse(input);
      const existing = await deps.store.getModelRunDraft(draft.id);
      if (existing && existing.profileId !== draft.profileId) {
        throw new Error("Model run draft profile does not match the active Profile.");
      }
      if (existing && existing.modelId !== draft.modelId) {
        throw new Error("A saved Model run draft cannot change Model identity.");
      }
      if (existing && (existing.status === "launched" || existing.status === "cancelled")) {
        if (JSON.stringify(existing) !== JSON.stringify(draft)) {
          throw new Error("Launched and cancelled Model runs are immutable.");
        }
        return existing;
      }
      const project = await deps.store.getModelProject(draft.modelId);
      if (!project || project.profileId !== draft.profileId) {
        throw new Error("Save the Model before saving its run draft.");
      }
      return deps.store.saveModelRunDraft({
        ...draft,
        createdAt: existing?.createdAt ?? draft.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    if (action === "delete_model_run_draft") {
      const draft = await deps.store.getModelRunDraft(
        requiredString(input.draftId, "draftId"),
      );
      if (!draft) return { deleted: false };
      if (draft.status === "launched") {
        throw new Error("A launched Model run cannot be deleted.");
      }
      await deps.store.deleteModelRunDraft(draft.id);
      return { deleted: true, draftId: draft.id };
    }
    if (action === "add_source") return deps.taskCreator.addSessionSource({ profileId: requiredString(input.profileId, "profileId"), sessionId: requiredString(input.sessionId, "sessionId"), turnIds: stringArray(input.turnIds), consentScope: input.consentScope === "selected_turns" ? "selected_turns" : "full_session" });
    if (action === "add_sources") {
      const profileId = requiredString(input.profileId, "profileId");
      const sources = [];
      for (const sessionId of requiredStringArray(input.sessionIds, "sessionIds")) {
        sources.push(await deps.taskCreator.addSessionSource({ profileId, sessionId, consentScope: "full_session" }));
      }
      return sources;
    }
    if (action === "estimate_sources") return deps.taskCreator.estimateSessionSources(requiredStringArray(input.sessionIds, "sessionIds"));
    if (action === "search_sources") return deps.chatSearch.search(TrainingChatSearchRequestSchema.parse(input));
    if (action === "dataset_rows") {
      if (!requestUrl) throw new Error("Dataset row query is missing its URL.");
      return deps.datasetArtifacts.rows(
        requiredString(input.tasksetId, "tasksetId"),
        {
          split: requestUrl.searchParams.get("split") || null,
          cursor: requestUrl.searchParams.get("cursor") || null,
          limit: Number(requestUrl.searchParams.get("limit") ?? 25),
          columns: requestUrl.searchParams.getAll("column"),
        },
      );
    }
    if (action === "taskset_operational_state") {
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const [attempts, artifacts, grades] = await Promise.all([
        deps.store.listTaskAttempts(tasksetId),
        deps.store.listTaskAttemptArtifacts({ tasksetId }),
        deps.store.listGradeResultsForTaskset(tasksetId),
      ]);
      return TasksetOperationalStateSchema.parse({
        schemaVersion: "openpond.tasksetOperationalState.v1",
        tasksetId,
        attempts,
        artifacts,
        grades,
        generatedAt: new Date().toISOString(),
      });
    }
    if (action === "inspect_huggingface_dataset") {
      return deps.datasetImports.inspectHuggingFace(
        CreateHuggingFaceDatasetImportRequestSchema.parse(input),
      );
    }
    if (action === "materialize_dataset_import") {
      const approved = ApproveDatasetImportMappingRequestSchema.parse(input);
      return deps.datasetImports.materialize({
        id: requiredString(input.importId, "importId"),
        ...approved,
      });
    }
    if (action === "cancel_dataset_import") {
      return deps.datasetImports.cancel(requiredString(input.importId, "importId"));
    }
    if (action === "init_taskset_draft") {
      const draft = createTasksetDraft({
        profileId: requiredString(input.profileId, "profileId"),
        name: string(input.name) ?? "",
      });
      return deps.store.saveTasksetDraft(draft);
    }
    if (action === "save_taskset_draft") {
      const submitted = TasksetDraftSchema.parse(input.draft);
      const current = await requireTasksetDraft(deps.store, submitted.id);
      if (submitted.profileId !== current.profileId) {
        throw new Error("Taskset draft profile cannot change.");
      }
      if (submitted.revision !== current.revision) {
        throw new Error(
          `Taskset draft changed from revision ${submitted.revision} to ${current.revision}. Refresh before saving.`,
        );
      }
      if (current.status === "published") {
        throw new Error("Published Taskset drafts are immutable. Initialize a new draft to revise the Taskset.");
      }
      return deps.store.saveTasksetDraft(TasksetDraftSchema.parse({
        ...submitted,
        revision: current.revision + 1,
        status: "draft",
        updatedAt: new Date().toISOString(),
      }));
    }
    if (action === "taskset_draft_workspace") {
      const workspace = await deps.store.getTasksetDraftWorkspace(
        requiredString(input.draftId, "draftId"),
      );
      if (!workspace) throw new Error("Taskset draft workspace was not found.");
      return workspace;
    }
    if (action === "publish_taskset_draft") {
      const draft = await requireTasksetDraft(
        deps.store,
        requiredString(input.draftId, "draftId"),
      );
      if (draft.status === "published") {
        const taskset = draft.publishedTasksetRef
          ? await deps.store.getTasksetRevision(
              draft.publishedTasksetRef.id,
              draft.publishedTasksetRef.revision,
              draft.publishedTasksetRef.contentHash,
            )
          : null;
        if (!taskset) throw new Error("Published Taskset draft lost its immutable Taskset revision.");
        return { draft, taskset };
      }
      const workspace = await deps.store.getTasksetDraftWorkspace(draft.id);
      if (!workspace) throw new Error("Taskset draft workspace was not found.");
      const materializedTaskset = publishTasksetDraft({
        draft,
        sourcePackageHash: workspace.packageHash,
      });
      await deps.store.upsertTaskset(materializedTaskset);
      await deps.evaluation.readiness(materializedTaskset.id);
      const taskset = await deps.store.getTaskset(materializedTaskset.id)
        ?? materializedTaskset;
      const published = TasksetDraftSchema.parse({
        ...draft,
        revision: draft.revision + 1,
        status: "published",
        publishedTasksetRef: {
          id: taskset.id,
          revision: taskset.revision,
          contentHash: taskset.contentHash,
        },
        updatedAt: new Date().toISOString(),
      });
      await deps.store.saveTasksetDraft(published);
      return { draft: published, taskset };
    }
    if (action === "delete_taskset_draft") {
      const draft = await requireTasksetDraft(
        deps.store,
        requiredString(input.draftId, "draftId"),
      );
      if (draft.status === "published") {
        throw new Error("Published Taskset draft history cannot be deleted from the authoring flow.");
      }
      await deps.store.deleteTasksetDraft(draft.id);
      return { deleted: true, draftId: draft.id };
    }
    if (action === "remove_source") { await deps.store.deleteTrainingSource(requiredString(input.sourceId, "sourceId")); return { removed: true }; }
    if (action === "delete_taskset") return deps.training.deleteTaskset(requiredString(input.tasksetId, "tasksetId"));
    if (action === "create_model_from_taskset") {
      const preferredBaseModel = requiredBaseModelPreference(
        input.preferredBaseModel,
        input.preferredBaseModelId,
      );
      return createModelFromTaskset({
        profileId: requiredString(input.profileId, "profileId"),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        preferredBaseModelId: preferredBaseModel.modelId,
        preferredBaseModel,
      });
    }
    if (action === "accept_harness_review") {
      const reviewRef = record(input.reviewRef);
      return startHarnessReviewTasksetAuthoring({
        store: deps.store,
        taskCreator: deps.taskCreator,
        startCreation: startModelCreation,
        profileId: requiredString(input.profileId, "profileId"),
        workspaceId: requiredString(input.workspaceId, "workspaceId"),
        reviewRef: {
          id: requiredString(reviewRef.id, "reviewRef.id"),
          contentHash: requiredString(reviewRef.contentHash, "reviewRef.contentHash"),
        },
        analysisModel: input.analysisModel ? ChatModelRefSchema.parse(input.analysisModel) : null,
        analysisReasoningEffort: input.analysisReasoningEffort
          ? CodexReasoningEffortSchema.parse(input.analysisReasoningEffort)
          : null,
      });
    }
    if (action === "start_creation") {
      const preferredBaseModel = nullableBaseModelPreference(
        input.preferredBaseModel,
        input.preferredBaseModelId,
      );
      return startModelCreation({
        profileId: requiredString(input.profileId, "profileId"),
        sourceIds: stringArray(input.sourceIds),
        surface: creationSurface(input.surface),
        mode: input.mode === "customize" ? "customize" : "defaults",
        entryMode: input.entryMode === "automated" ? "automated" : "manual",
        resourceIntent: input.resourceIntent === "dataset" ? "dataset" : "workproduct",
        buildIntent: datasetBuildIntent(input.buildIntent),
        buildSpecification: input.buildSpecification
          ? TaskCreationRequestSchema.shape.buildSpecification.parse(input.buildSpecification)
          : null,
        objective: string(input.objective),
        methodHint: trainingMethodHint(input.methodHint),
        preferredBaseModelId: preferredBaseModel?.modelId ?? null,
        preferredBaseModel,
        candidateId: string(input.candidateId),
        analysisModel: input.analysisModel ? ChatModelRefSchema.parse(input.analysisModel) : null,
        analysisReasoningEffort: input.analysisReasoningEffort ? CodexReasoningEffortSchema.parse(input.analysisReasoningEffort) : null,
        createImproveRunId: string(input.createImproveRunId),
        targetIntent: tasksetTargetIntent(input.targetIntent),
      });
    }
    if (action === "approve_disclosure") return syncCreation(await deps.taskCreator.approveDisclosure(requiredString(input.creationId, "creationId"), input.approved === true));
    if (action === "retry_creation") return retryModelCreation(requiredString(input.creationId, "creationId"));
    if (action === "answer_questions") return syncCreation(await deps.taskCreator.answerQuestions(requiredString(input.creationId, "creationId"), stringRecord(input.answers)));
    if (action === "approve_materialization") {
      const creation = await deps.taskCreator.approveMaterialization(requiredString(input.creationId, "creationId"), input.approved === true);
      if (creation.state === "ready" && creation.materializedTasksetId) {
        await deps.evaluation.readiness(creation.materializedTasksetId);
        const taskset = await deps.store.getTaskset(creation.materializedTasksetId);
        if (taskset) await linkHarnessReviewTaskset({ store: deps.store, taskset });
      }
      return syncCreation(creation);
    }
    if (action === "chat_creation") return syncCreation(await deps.taskCreator.chat(requiredString(input.creationId, "creationId"), requiredString(input.message, "message")));
    if (action === "rename_creation") return syncCreation(await deps.taskCreator.rename(requiredString(input.creationId, "creationId"), requiredString(input.name, "name")));
    if (action === "cancel_creation") return syncCreation(await deps.taskCreator.cancel(requiredString(input.creationId, "creationId")));
    if (action === "run_miner") return deps.taskMiner.startRun(RunTaskMinerRequestSchema.parse(input));
    if (action === "cancel_miner_run") return deps.taskMiner.cancelRun(requiredString(input.runId, "runId"));
    if (action === "configure_miner") return deps.taskMiner.updateConfig(requiredString(input.profileId, "profileId"), TaskMinerConfigSchema.parse(input.config));
    if (action === "patch_candidate") return deps.taskMiner.patch(requiredString(input.candidateId, "candidateId"), PatchTaskCandidateRequestSchema.parse(input.patch));
    if (action === "create_candidate") {
      const candidate = await deps.store.getTaskCandidate(requiredString(input.candidateId, "candidateId"));
      if (!candidate) throw new Error("Task Candidate not found.");
      const sourceIds = [...new Set(candidate.evidence.flatMap((item) => item.sourceRefIds))];
      await deps.taskMiner.patch(candidate.id, { status: "creating" });
      return startModelCreation({ profileId: candidate.profileId, sourceIds, surface: "task_candidate", mode: input.mode === "customize" ? "customize" : "defaults", entryMode: "automated", objective: string(input.objective) ?? candidate.summary, candidateId: candidate.id, analysisModel: input.analysisModel ? ChatModelRefSchema.parse(input.analysisModel) : null, analysisReasoningEffort: input.analysisReasoningEffort ? CodexReasoningEffortSchema.parse(input.analysisReasoningEffort) : null });
    }
    if (action === "grade") return deps.evaluation.grade({ tasksetId: requiredString(input.tasksetId, "tasksetId"), taskId: requiredString(input.taskId, "taskId"), attempt: input.attempt });
    if (action === "materialize_synthetic_collection") {
      const collection = SyntheticCollectionRunRequestSchema.parse({
        ...record(input.collection),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
      });
      const taskset = await deps.store.getTaskset(collection.tasksetId);
      if (!taskset) throw new Error("Collection Run Taskset was not found.");
      return materializeSyntheticCollectionRun({
        store: deps.store,
        storeDir: deps.storeDir,
        taskset,
        request: collection,
      });
    }
    if (action === "materialize_synthetic_preference_collection") {
      const collection = SyntheticCollectionRunRequestSchema.parse({
        ...record(input.collection),
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
      });
      const taskset = await requireTaskset(deps.store, collection.tasksetId);
      const preferenceComparisons = requirePreferenceComparisons(deps.preferenceComparisons);
      const actorKey = requiredString(input.actorKey, "actorKey");
      const tasksetRelease = await requireReleasedTaskset(deps.benchmarkTasksets, taskset);
      let comparisonReleaseId = string(input.comparisonReleaseId);
      if (!comparisonReleaseId) {
        const rubric = `Fixture-only systems smoke for: ${taskset.objective}`;
        const release = createPreferenceComparisonRelease({
          schemaVersion: "openpond.preferenceComparisonRelease.v1",
          id: `fixture-comparison-${taskset.id}-r${taskset.revision}-${contentHash(rubric).slice(0, 16)}`,
          revision: taskset.revision,
          tasksetRelease: {
            id: tasksetRelease.id,
            contentHash: tasksetRelease.contentHash,
          },
          candidateCount: 4,
          resultMode: "ordered_tie_groups",
          allowTies: true,
          allowRejectAll: true,
          presentation: {
            showTaskPrompt: true,
            randomizeCandidateOrder: true,
            hideModelIdentity: true,
            parts: [{ source: "attempt_output", path: "/text", renderer: "markdown" }],
          },
          rubricRef: {
            id: `fixture-rubric-${contentHash(rubric).slice(0, 24)}`,
            contentHash: contentHash(rubric),
            mediaType: "text/markdown",
            sizeBytes: Buffer.byteLength(rubric),
          },
          criteria: [{ id: "overall_quality", label: "Fixture order", instruction: rubric, weight: 1 }],
          assignment: { strategy: "randomized_blinded_v1", maxAssignmentsPerCandidate: 20 },
          aggregation: { algorithm: "mean_pairwise_win_fraction_v1", quorum: 1, rejectAllThreshold: 1 },
          rewardProjection: { algorithm: "pairwise_win_fraction_v1", verifierId: "preference-quality", verifierVersion: "1", weight: 1 },
          calibration: {
            minimumSamples: 1,
            minimumOrderAgreement: 1,
            minimumTieAgreement: 1,
            minimumOrderSwapAgreement: 1,
          },
          metadata: { source: "openpond-fixture-smoke" },
        });
        const existing = (await deps.store.listPreferenceComparisonReleases(taskset.id)).find((record) =>
          record.release.id === release.id && record.release.contentHash === release.contentHash,
        );
        const published = existing ?? await preferenceComparisons.publishRelease({
          tasksetId: taskset.id,
          tasksetRelease,
          release,
          publisherKey: actorKey,
        });
        if (!existing) await bindTasksetPreferenceComparison({ store: deps.store, taskset, release: published.release });
        comparisonReleaseId = published.release.id;
      }
      const collectionReceipt = await materializeSyntheticCollectionRun({
        store: deps.store,
        storeDir: deps.storeDir,
        taskset,
        request: collection,
      });
      // This identifies the fixture producer in immutable receipts. It is not
      // a configured provider and is never eligible to execute a model call.
      const context = compileDesktopHarnessContext({
        taskset,
        tasksetRelease,
        adapterId: "openpond-preference-comparisons-v1",
        model: { providerId: "custom-openai-compatible", modelId: "synthetic-collection-fixture-v1" },
      });
      const assignments = [];
      for (const groupIndex of [...new Set(collectionReceipt.attempts.map((item) => item.groupIndex))]) {
        const groupAttempts = collectionReceipt.attempts.filter((item) => item.groupIndex === groupIndex);
        const candidates: ComparisonAssignmentCandidateInput[] = [];
        for (const item of groupAttempts) {
          const grade = await deps.evaluation.grade({
            tasksetId: taskset.id,
            taskId: item.attempt.taskId,
            attempt: item.attempt,
          });
          const artifacts = await deps.store.listTaskAttemptArtifacts({ attemptId: item.attempt.id });
          const canonical = await persistCanonicalEvaluationEvidence({
            store: deps.store,
            storeDir: deps.storeDir,
            taskset,
            task: { id: item.attempt.taskId },
            context,
            attempt: item.attempt,
            grade,
            artifacts,
          });
          candidates.push({
            attempt: canonical.attemptReceipt,
            artifactManifest: canonical.artifactManifest,
            runManifest: context.runManifest,
            visibleArtifactIds: item.artifact ? [item.artifact.id] : [],
          });
        }
        const assignmentId = `collection-comparison-${contentHash([collection.id, groupIndex, comparisonReleaseId]).slice(0, 24)}`;
        const assignment = await preferenceComparisons.createAssignment({
          id: assignmentId,
          tasksetId: taskset.id,
          comparisonReleaseId,
          candidates,
          purpose: groupAttempts[0]!.partition === "reward_train" ? "training_reward" : "validation",
          creatorKey: actorKey,
        });
        const ratings = Object.fromEntries(groupAttempts.map((item, index) => [
          candidates[index]!.attempt.id,
          item.label,
        ]));
        await preferenceComparisons.submitFixtureReceipt({
          id: `collection-preference-${contentHash([assignment.id, collection.labelerRelease]).slice(0, 24)}`,
          tasksetId: taskset.id,
          assignmentId: assignment.id,
          actorKey,
          labelerRelease: collection.labelerRelease,
          fixtureRelease: collection.fixtureRelease,
          ratings,
          startedAt: collectionReceipt.createdAt,
        });
        assignments.push({ assignment, partition: groupAttempts[0]!.partition });
      }
      const dataset = await preferenceComparisons.materializePreferenceDataset({
        id: requiredString(input.preferenceDatasetId, "preferenceDatasetId"),
        revision: boundedInteger(input.preferenceDatasetRevision, "preferenceDatasetRevision", 1, 1_000_000, 1),
        tasksetId: taskset.id,
        comparisonReleaseId,
        authority: "synthetic_fixture",
        groups: assignments.map(({ assignment, partition }) => ({ assignmentId: assignment.id, partition })),
        actorKey,
      });
      return { collection: collectionReceipt, assignments, dataset };
    }
    if (action === "execute_taskset_attempt") {
      const sampling = record(input.sampling);
      return deps.evaluation.execute({
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        taskId: requiredString(input.taskId, "taskId"),
        model: ChatModelRefSchema.parse(input.model),
        seed: boundedInteger(input.seed, "seed", -2_147_483_648, 2_147_483_647, 17),
        attempt: boundedInteger(input.attempt, "attempt", 0, 1_000_000, 0),
        sampling: {
          maxOutputTokens: boundedInteger(
            sampling.maxOutputTokens,
            "sampling.maxOutputTokens",
            1,
            128_000,
            4_096,
          ),
          temperature: boundedNumber(
            sampling.temperature,
            "sampling.temperature",
            0,
            2,
            0,
          ),
          topP: boundedNumber(
            sampling.topP,
            "sampling.topP",
            0,
            1,
            1,
          ),
        },
        resultId: string(input.resultId) ?? undefined,
      });
    }
    if (action === "execute_harness_review_baseline") {
      const reviewRef = record(input.reviewRef);
      const sampling = record(input.sampling);
      return deps.evaluation.executeBaseline({
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        model: ChatModelRefSchema.parse(input.model),
        reviewRef: {
          id: requiredString(reviewRef.id, "reviewRef.id"),
          contentHash: requiredString(reviewRef.contentHash, "reviewRef.contentHash"),
        },
        seeds: harnessIntegerArray(input.seeds, "seeds"),
        attemptsPerTask: boundedInteger(
          input.attemptsPerTask,
          "attemptsPerTask",
          1,
          20,
          1,
        ),
        sampling: {
          maxOutputTokens: boundedInteger(
            sampling.maxOutputTokens,
            "sampling.maxOutputTokens",
            1,
            128_000,
            4_096,
          ),
          temperature: boundedNumber(
            sampling.temperature,
            "sampling.temperature",
            0,
            2,
            0,
          ),
          topP: boundedNumber(sampling.topP, "sampling.topP", 0, 1, 1),
        },
      });
    }
    if (action === "qualify_harness_model_improvement") {
      const reviewRef = requiredImmutableRef(input.reviewRef, "reviewRef");
      return qualifyHarnessModelImprovement({
        store: deps.store,
        tasksetId: requiredString(input.tasksetId, "tasksetId"),
        baselineEvaluationId: requiredString(input.baselineEvaluationId, "baselineEvaluationId"),
        reviewRef,
        privacyApproval: optionalImmutableRef(input.privacyApproval, "privacyApproval"),
        budgetApproval: optionalImmutableRef(input.budgetApproval, "budgetApproval"),
        maximumCostUsd: nonnegativeHarnessNumber(input.maximumCostUsd, "maximumCostUsd"),
      });
    }
    if (action === "audit_graders") return deps.evaluation.auditFixtures({ tasksetId: requiredString(input.tasksetId, "tasksetId"), fixtures: Array.isArray(input.fixtures) ? input.fixtures as never[] : undefined });
    if (action === "calibrate_judges") return deps.evaluation.calibrateModelJudges(requiredString(input.tasksetId, "tasksetId"));
    if (action === "readiness") return deps.evaluation.readiness(requiredString(input.tasksetId, "tasksetId"));
    if (action === "preview_expert_bootstrap") return deps.training.previewExpertBootstrap(requiredString(input.tasksetId, "tasksetId"));
    if (action === "approve_expert_bootstrap") return deps.training.approveExpertBootstrap({
      tasksetId: requiredString(input.tasksetId, "tasksetId"),
      previewHash: requiredString(input.previewHash, "previewHash"),
    });
    if (action === "create_plan") return deps.training.createPlan({ modelId: requiredString(input.modelId, "modelId"), tasksetId: requiredString(input.tasksetId, "tasksetId"), destinationId: TrainingDestinationIdSchema.parse(input.destinationId), recipe: input.recipe, environmentPlacement: managedRolloutPlacement(input.environmentPlacement), exportApproved: input.exportApproved === true, retentionDays: nullableNumber(input.retentionDays), region: string(input.region) });
    if (action === "prepare_qualified_model_improvement") {
      const qualificationRef = requiredImmutableRef(input.qualificationRef, "qualificationRef");
      const workspaceId = requiredString(input.workspaceId, "workspaceId");
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const recipe = record(input.recipe);
      const destinationId = TrainingDestinationIdSchema.parse(input.destinationId);
      const qualification = await requireQualifiedModelImprovement({
        store: deps.store,
        workspaceId,
        qualificationRef,
        tasksetId,
        recipe,
        baseModelId: recipeBaseModelId(recipe),
      });
      if (qualification.decision === "rl" && destinationId !== "openpond_managed") {
        throw new Error("Qualified RL must use the OpenPond Managed boundary.");
      }
      const prepared = await deps.training.prepareStart({
        modelId: requiredString(input.modelId, "modelId"),
        tasksetId,
        destinationId,
        recipe,
        environmentPlacement: managedRolloutPlacement(input.environmentPlacement),
        exportApproved: input.exportApproved === true,
        retentionDays: nullableNumber(input.retentionDays),
        region: string(input.region),
        harnessRelease: qualification.harnessRelease,
        modelImprovementQualification: qualificationRef,
      });
      if (
        prepared.plan.estimatedCostUsd !== null &&
        prepared.plan.estimatedCostUsd > qualification.maximumCostUsd
      ) {
        throw new Error("Prepared Training Plan exceeds the qualified maximum cost.");
      }
      return { qualification, prepared };
    }
    if (action === "prepare_model_run") return deps.training.prepareModelRun({
      modelRunId: requiredString(input.modelRunId, "modelRunId"),
      maximumSpendUsd: nullableNumber(input.maximumSpendUsd),
      retentionDays: nullableNumber(input.retentionDays),
    });
    if (action === "start_model_run") {
      const modelRunId = requiredString(input.modelRunId, "modelRunId");
      const modelRun = await deps.store.getModelRunDraft(modelRunId);
      if (!modelRun || modelRun.status !== "ready_to_run") {
        throw new Error("A ready saved Model Run is required.");
      }
      if (modelRun.destinationId === "openpond_managed") {
        if (!deps.modelProjectHosting) {
          throw new Error("Managed runs require hosted Model Project sync.");
        }
        if (!modelRun.tasksetRef) {
          throw new Error("The saved Model Run has no Taskset.");
        }
        const taskset = await requireTaskset(deps.store, modelRun.tasksetRef.id);
        const release = await requireReleasedTaskset(
          deps.benchmarkTasksets,
          taskset,
        );
        await deps.modelProjectHosting.publishTaskset({
          projectId: modelRun.modelId,
          taskset,
          release,
        });
      }
      return deps.training.startModelRun({
        modelRunId,
        maximumSpendUsd: nullableNumber(input.maximumSpendUsd),
        retentionDays: nullableNumber(input.retentionDays),
        exportApproved: input.exportApproved === true,
        manifest: input.manifest,
      });
    }
    if (isModelRunControlAction(action)) return handleModelRunControl({
      action,
      modelRunId: input.modelRunId,
      loadRun: (id) => deps.store.getModelRun(id),
      training: deps.training,
      harnessRefinerBenchmarks: deps.harnessRefinerBenchmarks,
    });
    if (action === "build_bundle") return deps.training.buildBundle(requiredString(input.planId, "planId"));
    if (action === "approve_training") return deps.training.approve({ planId: requiredString(input.planId, "planId"), bundleId: requiredString(input.bundleId, "bundleId"), approvedBy: string(input.approvedBy) ?? undefined, maximumCostUsd: nullableNumber(input.maximumCostUsd) });
    if (action === "launch") return deps.training.launch({ planId: requiredString(input.planId, "planId"), approvalId: requiredString(input.approvalId, "approvalId") });
    if (action === "prepare_start") return deps.training.prepareStart({
      modelId: requiredString(input.modelId, "modelId"),
      tasksetId: requiredString(input.tasksetId, "tasksetId"),
      destinationId: TrainingDestinationIdSchema.parse(input.destinationId),
      recipe: input.recipe,
      environmentPlacement: managedRolloutPlacement(input.environmentPlacement),
      exportApproved: input.exportApproved === true,
      retentionDays: nullableNumber(input.retentionDays),
      region: string(input.region),
    });
    if (action === "start_prepared") {
      const result = await deps.training.startPrepared({
        planId: requiredString(input.planId, "planId"),
        bundleId: requiredString(input.bundleId, "bundleId"),
        maximumCostUsd: nullableNumber(input.maximumCostUsd),
      });
      return linkStartedTraining(result);
    }
    if (action === "start_qualified_model_improvement") {
      const qualificationRef = requiredImmutableRef(input.qualificationRef, "qualificationRef");
      const planId = requiredString(input.planId, "planId");
      const bundleId = requiredString(input.bundleId, "bundleId");
      const plan = await deps.store.getTrainingPlan(planId);
      if (!plan || !sameImmutableRef(plan.modelImprovementQualification, qualificationRef)) {
        throw new Error("Prepared Training Plan does not match the supplied qualification.");
      }
      const maximumCostUsd = nonnegativeHarnessNumber(input.maximumCostUsd, "maximumCostUsd");
      const qualification = await requireQualifiedModelImprovement({
        store: deps.store,
        workspaceId: requiredString(input.workspaceId, "workspaceId"),
        qualificationRef,
        tasksetId: plan.tasksetId,
        recipe: plan.recipe,
        baseModelId: recipeBaseModelId(plan.recipe),
        maximumCostUsd,
      });
      const result = await deps.training.startPrepared({
        planId,
        bundleId,
        maximumCostUsd,
      });
      return { ...await linkStartedTraining(result), qualification };
    }
    if (action === "start") {
      const result = await deps.training.start({ modelId: requiredString(input.modelId, "modelId"), tasksetId: requiredString(input.tasksetId, "tasksetId"), destinationId: TrainingDestinationIdSchema.parse(input.destinationId), recipe: input.recipe, environmentPlacement: managedRolloutPlacement(input.environmentPlacement), exportApproved: input.exportApproved === true, maximumCostUsd: nullableNumber(input.maximumCostUsd), retentionDays: nullableNumber(input.retentionDays), region: string(input.region) });
      return linkStartedTraining(result);
    }
    if (action === "export_bundle") return deps.training.exportBundle(requiredString(input.bundleId, "bundleId"));
    if (action === "artifact_download") return deps.training.artifactDownload(requiredString(input.artifactId, "artifactId"));
    if (action === "model_package_download") return deps.training.modelPackageDownload(requiredString(input.modelId, "modelId"));
    if (action === "reject_model") return deps.training.rejectModel({ modelId: requiredString(input.modelId, "modelId"), reason: requiredString(input.reason, "reason") });
    if (action === "bind_model") return deps.training.bindModel({
      profileId: requiredString(input.profileId, "profileId"),
      modelId: requiredString(input.modelId, "modelId"),
      role: requiredString(input.role, "role") as never,
      roleTargetId: requiredString(input.roleTargetId, "roleTargetId"),
      promotedBy: string(input.promotedBy) ?? undefined,
    });
    if (action === "rollback_model_binding") return deps.training.rollbackModelBinding({
      bindingId: requiredString(input.bindingId, "bindingId"),
      rolledBackBy: string(input.rolledBackBy) ?? undefined,
    });
    if (action === "update_model_configuration") return deps.training.updateModelConfiguration({ modelId: requiredString(input.modelId, "modelId"), configuration: record(input.configuration) });
    if (action === "set_model_pinned") return deps.training.setModelPinned({
      modelId: requiredString(input.modelId, "modelId"),
      pinned: input.pinned === true,
    });
    if (action === "cancel_job") return deps.training.cancelJob(requiredString(input.jobId, "jobId"));
    if (action === "job_events") return deps.store.listTrainingJobEvents(requiredString(input.jobId, "jobId"));
    if (action === "run_detail") {
      const jobId = requiredString(input.jobId, "jobId");
      await deps.training.refreshManagedRunEvidence(jobId).catch(() => undefined);
      return trainingRunDetail(deps.store, jobId);
    }
    throw new Error(`Unknown training action ${action}.`);
  }

  async function linkStartedTraining(result: StartedTrainingResult) {
    const taskset = await deps.store.getTaskset(result.plan.tasksetId);
    if (!taskset) return result;
    const linkedRuns = await deps.store.listCreateImproveRuns({
      profileId: taskset.profileId,
      targetKind: "model",
      limit: 100,
    });
    const stableModelId = result.plan.modelId;
    const exactRun = linkedRuns.find((candidate) =>
      candidate.target.id === stableModelId
      &&
      candidate.tasksetRef?.id === taskset.id
      && candidate.tasksetRef.revision === taskset.revision
      && candidate.tasksetRef.contentHash === taskset.contentHash
      && candidate.target.kind === "model"
      && !candidate.target.trainingPlanId
      && !candidate.target.trainingJobId
      && !candidate.target.artifactId
      && candidate.externalExecutionRefs.length === 0
      && candidate.evaluationReceipts.length === 0) ?? null;
    const unexecutedPriorRun = linkedRuns.find((candidate) =>
      candidate.target.id === stableModelId
      &&
      candidate.tasksetRef?.id === taskset.id
      && candidate.target.kind === "model"
      && !candidate.target.trainingPlanId
      && !candidate.target.trainingJobId
      && !candidate.target.artifactId
      && candidate.externalExecutionRefs.length === 0
      && candidate.evaluationReceipts.length === 0) ?? null;
    const linkedRun = exactRun
      ?? (unexecutedPriorRun
        ? advanceUnexecutedModelRunTasksetRef(unexecutedPriorRun, taskset)
        : null);
    let run;
    if (linkedRun?.tasksetRef) {
      run = attachModelTargetRefs({
        run: linkedRun,
        tasksetId: taskset.id,
        trainingPlanId: result.plan.id,
        trainingJobId: result.job.id,
      });
    } else {
      const sources = (await Promise.all(
        taskset.sourceRefs.map((source) => deps.store.getTrainingSource(source.id)),
      )).filter((source): source is NonNullable<typeof source> => Boolean(source));
      const timestamp = new Date().toISOString();
      const evidenceSnapshot = createEvidenceSnapshot({
        objective: taskset.objective,
        sources,
        timestamp,
      });
      run = createModelTrainingCreateImproveRun({
        profileId: taskset.profileId,
        modelId: stableModelId,
        tasksetId: result.plan.tasksetId,
        displayName: linkedRuns.find(
          (candidate) => candidate.target.id === stableModelId,
        )?.target.displayName ?? taskset.name,
        trainingPlanId: result.plan.id,
        trainingJobId: result.job.id,
        tasksetRef: createTasksetRef({
          taskset,
          evidenceSnapshotIds: [evidenceSnapshot.id],
          approvedAt: timestamp,
        }),
        evidenceSnapshots: [evidenceSnapshot],
      });
    }
    await deps.store.upsertCreateImproveRun(run);
    return { ...result, createImproveRunId: run.id };
  }

  async function state(profileId: string) {
    await deps.benchmarkTasksets.ensureHarnessRefiner({ profileId });
    const [
      sources,
      creations,
      tasksetDrafts,
      tasksets,
      datasetImports,
      datasetArtifacts,
      candidates,
      minerConfig,
      minerRuns,
      modelProjects,
      modelRunDrafts,
      modelVersions,
      modelRuns,
      modelTasksets,
      execution,
    ] = await Promise.all([
      deps.store.listTrainingSources(profileId),
      deps.store.listTaskCreationSnapshots(profileId),
      deps.store.listTasksetDrafts(profileId),
      deps.store.listTasksets(profileId),
      deps.store.listDatasetImportJobs(profileId),
      deps.datasetArtifacts.summaries(profileId),
      deps.store.listTaskCandidates(profileId, "all"),
      deps.taskMiner.config(profileId),
      deps.store.listTaskMinerRuns(profileId),
      deps.store.listModelProjects(),
      deps.store.listModelRunDrafts(),
      deps.store.listModelVersions(),
      deps.store.listModelRuns(),
      deps.store.listTasksets(),
      deps.training.state(),
    ]);
    await syncModelTrainingCreateImproveRuns({ store: deps.store, profileId, execution });
    const graderAuditReports = (await Promise.all(tasksets.map((taskset) => deps.store.listGraderAuditReports(taskset.id)))).flat();
    const evaluationResults = (await Promise.all(
      tasksets.map((taskset) => deps.store.listEvaluationResults(taskset.id)),
    )).flat();
    const { benchmarkRuns, benchmarkComparisons } = await loadBenchmarkHistory(
      deps.store,
      tasksets,
    );
    const activity = projectTrainingActivity({
      profileId,
      state: {
        jobs: execution.jobs,
        creations,
        minerRuns,
        datasetImports,
      },
    });
    return {
      schemaVersion: "openpond.trainingState.v1",
      profileId,
      sources,
      creations,
      tasksetDrafts,
      tasksets,
      benchmarkRuns,
      benchmarkComparisons,
      datasetImports,
      datasetArtifacts,
      graderAuditReports,
      evaluationResults,
      candidates,
      minerConfig,
      minerRuns,
      modelProjects,
      modelRunDrafts,
      modelVersions,
      modelRuns,
      modelTasksets,
      ...execution,
      activityRevision: activity.revision,
      generatedAt: new Date().toISOString(),
    };
  }

  async function activity(profileId: string) {
    const [creations, datasetImports, minerRuns, execution] = await Promise.all([
      deps.store.listTaskCreationSnapshots(profileId),
      deps.store.listDatasetImportJobs(profileId),
      deps.store.listTaskMinerRuns(profileId),
      deps.training.activity(),
    ]);
    return projectTrainingActivity({
      profileId,
      state: {
        jobs: execution.jobs,
        creations,
        minerRuns,
        datasetImports,
      },
    });
  }

  async function datasetCatalog(profileId: string) {
    const [tasksets, artifactSummaries] = await Promise.all([
      deps.store.listDatasetCatalogTasksets(profileId),
      deps.datasetArtifacts.summaries(profileId),
    ]);
    const summariesByTaskset = new Map(
      artifactSummaries.map((summary) => [summary.tasksetId, summary]),
    );
    return DatasetCatalogResponseSchema.parse({
      schemaVersion: "openpond.datasetCatalog.v1",
      profileId,
      datasets: tasksets.map((taskset) => {
        const summary = summariesByTaskset.get(taskset.tasksetId) ?? null;
        const artifactBacked = taskset.storageKind === "parquet";
        return {
          schemaVersion: "openpond.datasetCatalogItem.v1",
          tasksetId: taskset.tasksetId,
          tasksetRevision: taskset.tasksetRevision,
          artifactId: taskset.artifactId,
          name: taskset.name,
          status: taskset.status,
          storageKind: taskset.storageKind,
          rowCount: taskset.rowCount,
          splitCounts: taskset.splitCounts,
          sizeBytes: summary?.sizeBytes ?? null,
          available: artifactBacked ? summary?.available === true : true,
          unavailableReason: artifactBacked
            ? summary?.unavailableReason
              ?? (summary
                ? null
                : "The Dataset artifact is not registered in storage.")
            : null,
          createdAt: taskset.createdAt,
          updatedAt: taskset.updatedAt,
        };
      }),
      generatedAt: new Date().toISOString(),
    });
  }

  async function startModelCreation(
    input: Parameters<TaskCreator["start"]>[0],
  ) {
    const sources = (await Promise.all(
      input.sourceIds.map((sourceId) => deps.store.getTrainingSource(sourceId)),
    )).filter((source): source is NonNullable<typeof source> => Boolean(source));
    const freshRun = createTasksetAuthoringCreateImproveRun({
      profileId: input.profileId,
      objective: input.objective ?? null,
      sourceIds: input.sourceIds,
      sources,
      targetIntent: input.targetIntent,
      resourceIntent: input.resourceIntent,
      preferredBaseModelId: input.preferredBaseModelId,
      preferredBaseModel: input.preferredBaseModel,
    });
    const existingRun = input.createImproveRunId
      ? await deps.store.getCreateImproveRun(input.createImproveRunId)
      : null;
    if (input.createImproveRunId && !existingRun) {
      throw new Error(`Create/Improve run ${input.createImproveRunId} was not found.`);
    }
    if (existingRun && existingRun.scope.profileId !== input.profileId) {
      throw new Error("Create/Improve run profile does not match Taskset authoring.");
    }
    const run = existingRun
      ? nextCreateImproveRunRevision(existingRun, {
          objective: freshRun.objective,
          target: freshRun.target,
          evidenceSnapshots: freshRun.evidenceSnapshots,
          sourceRefs: freshRun.sourceRefs,
          blockedReason: null,
          metadata: {
            ...existingRun.metadata,
            preferredBaseModelId: input.preferredBaseModelId ?? null,
            preferredBaseModel: input.preferredBaseModel ?? null,
          },
          updatedAt: freshRun.updatedAt,
        })
      : freshRun;
    await deps.store.upsertCreateImproveRun(run);
    try {
      const creation = await deps.taskCreator.start({
        ...input,
        createImproveRunId: run.id,
      });
      await syncTasksetAuthoringCreateImproveRun(deps.store, creation);
      return creation;
    } catch (error) {
      await failTasksetAuthoringCreateImproveRun(deps.store, run, error);
      throw error;
    }
  }

  async function createModelFromTaskset(input: {
    profileId: string;
    tasksetId: string;
    preferredBaseModelId: string;
    preferredBaseModel: BaseModelPreference;
  }) {
    const taskset = await deps.store.getTaskset(input.tasksetId);
    if (!taskset) throw new Error("Dataset not found.");
    if (taskset.profileId !== input.profileId) {
      throw new Error("Dataset profile does not match the active Profile.");
    }
    const linkedRuns = await deps.store.listCreateImproveRuns({
      profileId: input.profileId,
      targetKind: "model",
      limit: 250,
    });
    const existing = linkedRuns.find(
      (run) =>
        run.tasksetRef?.id === taskset.id &&
        run.tasksetRef.revision === taskset.revision &&
        run.tasksetRef.contentHash === taskset.contentHash,
    );
    if (existing) {
      const preferenceChanged =
        existing.metadata.preferredBaseModelId !== input.preferredBaseModelId
        || JSON.stringify(existing.metadata.preferredBaseModel ?? null)
          !== JSON.stringify(input.preferredBaseModel);
      if (
        preferenceChanged &&
        existing.target.kind === "model" &&
        !existing.target.trainingPlanId &&
        !existing.target.trainingJobId &&
        !existing.target.artifactId &&
        existing.externalExecutionRefs.length === 0
      ) {
        const updated = nextCreateImproveRunRevision(existing, {
          metadata: {
            ...existing.metadata,
            preferredBaseModelId: input.preferredBaseModelId,
            preferredBaseModel: input.preferredBaseModel,
          },
          updatedAt: new Date().toISOString(),
        });
        return deps.store.upsertCreateImproveRun(updated);
      }
      return existing;
    }
    const run = createExistingTasksetModelCreateImproveRun({
      profileId: input.profileId,
      taskset,
      preferredBaseModelId: input.preferredBaseModelId,
      preferredBaseModel: input.preferredBaseModel,
    });
    return deps.store.upsertCreateImproveRun(run);
  }

  async function retryModelCreation(id: string): Promise<TaskCreationSnapshot> {
    let creation = await deps.store.getTaskCreationSnapshot(id);
    if (!creation) throw new Error("Task creation not found.");
    if (creation.state !== "failed") {
      return syncCreation(await deps.taskCreator.retry(id));
    }
    const priorRun = creation.request.createImproveRunId
      ? await deps.store.getCreateImproveRun(creation.request.createImproveRunId)
      : null;
    if (priorRun?.state === "failed") {
      const sources = (await Promise.all(
        creation.request.sourceIds.map((sourceId) => deps.store.getTrainingSource(sourceId)),
      )).filter((source): source is NonNullable<typeof source> => Boolean(source));
      const stableTargetId = priorRun.target.kind === "unselected"
        ? creation.request.targetIntent.id
        : priorRun.target.id ?? priorRun.id;
      const targetIntent = {
        ...creation.request.targetIntent,
        id: stableTargetId,
        displayName: priorRun.target.displayName
          ?? creation.request.targetIntent.displayName,
      };
      const timestamp = new Date().toISOString();
      const retryRun = createTasksetAuthoringCreateImproveRun({
        profileId: creation.request.profileId,
        objective: creation.request.objective,
        sourceIds: creation.request.sourceIds,
        sources,
        targetIntent,
        resourceIntent: creation.request.resourceIntent,
        preferredBaseModelId: creation.request.preferredBaseModelId,
        preferredBaseModel: creation.request.preferredBaseModel,
        timestamp,
      });
      await deps.store.upsertCreateImproveRun({
        ...retryRun,
        iterationPolicy: {
          mode: "bounded",
          maximumAttempts: Math.min(20, priorRun.iterationPolicy.maximumAttempts + 1),
          currentAttempt: Math.min(20, priorRun.iterationPolicy.currentAttempt + 1),
        },
        metadata: {
          ...retryRun.metadata,
          retryOfRunId: priorRun.id,
          retryOfTaskCreationId: creation.id,
        },
      });
      creation = await deps.store.upsertTaskCreationSnapshot({
        ...creation,
        request: {
          ...creation.request,
          createImproveRunId: retryRun.id,
          targetIntent,
        },
        updatedAt: timestamp,
      });
    }
    return syncCreation(await deps.taskCreator.retry(creation.id));
  }

  async function syncCreation(creation: TaskCreationSnapshot): Promise<TaskCreationSnapshot> {
    await syncTasksetAuthoringCreateImproveRun(deps.store, creation);
    return creation;
  }

  return { request, state };
}

function portableMethod(
  value: string | null | undefined,
): "sft" | "dpo" | "grpo" | "ppo" | undefined {
  return value === "sft" || value === "dpo" || value === "grpo" || value === "ppo"
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requiredString(value: unknown, name: string): string { const parsed = string(value); if (!parsed) throw new Error(`${name} is required.`); return parsed; }
function nullableString(value: unknown): string | null { return string(value); }
function optionalStringArray(value: unknown): string[] | undefined { return value === undefined ? undefined : requiredStringArray(value, "value"); }
function requiredRecordArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`${name} requires at least one object.`);
  }
  return value as Record<string, unknown>[];
}
function optionalRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  return value === undefined ? undefined : requiredRecordArray(value, "value");
}
function requiredStringGroupArray(value: unknown, name: string): string[][] {
  if (!Array.isArray(value) || value.some((group) => !Array.isArray(group) || !group.length)) {
    throw new Error(`${name} must be an array of non-empty candidate groups.`);
  }
  return (value as unknown[][]).map((group) => group.map((candidate) => requiredString(candidate, `${name} candidate`)));
}
function preferenceComparisonPurpose(value: unknown): PreferenceComparisonPurpose {
  if (value === "training_reward" || value === "validation" || value === "frozen_eval" || value === "calibration") return value;
  throw new Error("purpose must be training_reward, validation, frozen_eval, or calibration.");
}

function preferenceModelReviewVariant(value: unknown): "canonical" | "order_swap" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "canonical" || value === "order_swap") return value;
  throw new Error("reviewVariant must be canonical or order_swap.");
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("minimumSamples must be a positive integer.");
  }
  return value;
}
function preferenceReviewer(value: unknown): PreferenceReviewer {
  const reviewer = record(value);
  if (reviewer.kind !== "human") throw new Error("reviewer.kind must be human for reviewer submissions.");
  const releaseRef = record(reviewer.releaseRef);
  return {
    kind: "human",
    releaseRef: {
      id: requiredString(releaseRef.id, "reviewer.releaseRef.id"),
      contentHash: requiredString(releaseRef.contentHash, "reviewer.releaseRef.contentHash"),
    },
  };
}
function optionalArtifactRef(value: unknown): { id: string; contentHash: string; mediaType: string; sizeBytes: number } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const artifact = record(value);
  const sizeBytes = artifact.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("feedbackArtifactRef.sizeBytes must be a non-negative integer.");
  }
  return {
    id: requiredString(artifact.id, "feedbackArtifactRef.id"),
    contentHash: requiredString(artifact.contentHash, "feedbackArtifactRef.contentHash"),
    mediaType: requiredString(artifact.mediaType, "feedbackArtifactRef.mediaType"),
    sizeBytes,
  };
}
function optionalScoreRecord(value: unknown): Record<string, Record<string, number>> | undefined {
  if (value === undefined || value === null) return undefined;
  const outer = record(value);
  const scores: Record<string, Record<string, number>> = {};
  for (const [candidateId, candidateScores] of Object.entries(outer)) {
    const inner = record(candidateScores);
    scores[candidateId] = {};
    for (const [criterionId, score] of Object.entries(inner)) {
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error("criterion scores must be finite values from 0 to 1.");
      }
      scores[candidateId]![criterionId] = score;
    }
  }
  return scores;
}
function requirePreferenceComparisons(value: PreferenceComparisons | undefined): PreferenceComparisons {
  if (!value) throw new Error("Preference comparisons are unavailable in this server build.");
  return value;
}
async function requireTaskset(store: SqliteStore, tasksetId: string) {
  const taskset = await store.getTaskset(tasksetId);
  if (!taskset) throw new Error("Taskset was not found.");
  return taskset;
}
async function requireTasksetDraft(store: SqliteStore, draftId: string) {
  const draft = await store.getTasksetDraft(draftId);
  if (!draft) throw new Error("Taskset draft was not found.");
  return draft;
}
async function requireReleasedTaskset(
  benchmarkTasksets: BenchmarkTasksets,
  taskset: Awaited<ReturnType<typeof requireTaskset>>,
): Promise<TasksetRelease> {
  const release = await benchmarkTasksets.releaseForTaskset(taskset);
  if (release) return release;
  return materializePortableTasksetRelease({
    taskset,
    adapterId: "openpond-preference-comparisons-v1",
  }).tasksetRelease;
}
async function bindTasksetPreferenceComparison(input: {
  store: SqliteStore;
  taskset: Awaited<ReturnType<typeof requireTaskset>>;
  release: PreferenceComparisonRelease;
}): Promise<void> {
  const timestamp = new Date().toISOString();
  const unhashed = TasksetSchema.parse({
    ...input.taskset,
    revision: input.taskset.revision + 1,
    preferenceComparison: {
      schemaVersion: "openpond.tasksetPreferenceComparisonBinding.v1",
      releaseId: input.release.id,
      releaseHash: input.release.contentHash,
      publishedAt: timestamp,
      metadata: {},
    },
    contentHash: "00000000",
    updatedAt: timestamp,
  });
  await input.store.upsertTaskset(TasksetSchema.parse({
    ...unhashed,
    contentHash: computeTasksetHash(unhashed),
  }));
}
function humanPreferenceReviewer(reviewerKey: string): PreferenceReviewer {
  const id = `human-reviewer:${reviewerKey}`;
  return {
    kind: "human",
    releaseRef: {
      id,
      contentHash: contentHash({ schemaVersion: "openpond.humanPreferenceReviewer.v1", reviewerKey }),
    },
  };
}
async function preferenceComparisonReviewPayload(
  store: SqliteStore,
  assignment: Awaited<ReturnType<PreferenceComparisons["nextAssignment"]>> & {},
  reviewer: PreferenceReviewer,
) {
  const taskset = await store.getTaskset(assignment.tasksetId);
  const task = taskset?.tasks.find((candidate) => candidate.id === assignment.assignment.taskRef.id) ?? null;
  const attempts = await store.listTaskAttempts(assignment.tasksetId);
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const candidates = await Promise.all(assignment.assignment.presentedCandidateOrder.map(async (attemptId, index) => {
    const candidate = assignment.assignment.candidates.find((item) => item.attemptRef.id === attemptId)!;
    const attempt = attemptById.get(attemptId) ?? null;
    const artifacts = await store.listTaskAttemptArtifacts({ attemptId });
    const visibleIds = new Set(candidate.visibleArtifactIds);
    return {
      label: `candidate-${index + 1}`,
      attemptId,
      output: attempt?.output ?? {},
      artifacts: artifacts
        .filter((artifact) => visibleIds.has(artifact.id))
        .map((artifact) => ({
          id: artifact.id,
          mediaType: artifact.mediaType,
          sizeBytes: artifact.sizeBytes,
        })),
    };
  }));
  return {
    assignment,
    reviewer,
    taskPrompt: task?.input ?? null,
    candidates,
  };
}
function nullableBaseModelPreference(value: unknown, legacyId: unknown): BaseModelPreference | null {
  const parsed = BaseModelPreferenceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const modelId = string(legacyId);
  return modelId ? legacyBaseModelPreference(modelId) : null;
}
function requiredBaseModelPreference(value: unknown, legacyId: unknown): BaseModelPreference {
  const preference = nullableBaseModelPreference(value, legacyId);
  if (!preference) throw new Error("preferredBaseModel is required.");
  return preference;
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : []; }
function requiredStringArray(value: unknown, name: string): string[] { const parsed = stringArray(value); if (!parsed.length) throw new Error(`${name} requires at least one value.`); return parsed; }
function stringRecord(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
function boundedNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}
function managedRolloutPlacement(value: unknown): "local" | "remote" | undefined { return value === "local" || value === "remote" ? value : undefined; }

function preferenceDatasetPartition(value: unknown): "reward_train" | "reward_validation" | "reward_qualification" {
  if (value === "reward_train" || value === "reward_validation" || value === "reward_qualification") {
    return value;
  }
  throw new Error("Preference dataset partition must be reward_train, reward_validation, or reward_qualification.");
}

function preferenceRatings(value: unknown): Record<string, "love" | "like" | "reject"> {
  const ratings = record(value);
  return Object.fromEntries(Object.entries(ratings).map(([attemptId, rating]) => {
    if (rating !== "love" && rating !== "like" && rating !== "reject") {
      throw new Error(`Preference rating for ${attemptId} must be love, like, or reject.`);
    }
    return [attemptId, rating];
  }));
}

function datasetBuildIntent(value: unknown): TaskCreationRequest["buildIntent"] {
  return value === "preferences" || value === "verifiable_reward" || value === "rubric" || value === "discovery"
    ? value
    : "demonstrations";
}

function trainingMethodHint(value: unknown): TaskCreationRequest["methodHint"] {
  return value === "sft" || value === "dpo" || value === "grpo" || value === "ppo"
    ? value
    : null;
}
function tasksetTargetIntent(value: unknown): TaskCreationRequest["targetIntent"] {
  const candidate = record(value);
  const kind = candidate.kind;
  return {
    kind: kind === "agent" || kind === "skill" || kind === "extension" || kind === "model" || kind === "configuration" ? kind : null,
    id: string(candidate.id),
    displayName: string(candidate.displayName),
    operation: candidate.operation === "improve" ? "improve" : "create",
  };
}
function creationSurface(value: unknown) { return value === "session_menu" || value === "bulk_selection" || value === "training_page" || value === "task_candidate" ? value : "slash_train"; }
