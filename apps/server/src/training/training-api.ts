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
  TrainingDestinationIdSchema,
  TrainingChatSearchRequestSchema,
  type BaseModelPreference,
  type TaskCreationRequest,
  type TaskCreationSnapshot,
} from "@openpond/contracts";
import {
  PreferenceComparisonReleaseSchema,
  type ComparisonAssignmentCandidateInput,
  type HarnessCompatibilityReceipt,
  type PreferenceComparisonPurpose,
  type PreferenceReviewer,
  type TasksetRelease,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import type { SqliteStore } from "../store/store.js";
import type { createTaskCreatorService } from "./task-creator.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createTaskMinerService } from "./task-miner.js";
import type { createTrainingService } from "./training-service.js";
import type { createTrainingChatSearchService } from "./training-chat-search.js";
import type { createDatasetArtifactService } from "./dataset-artifact-service.js";
import type { createDatasetImportService } from "./dataset-imports/import-service.js";
import type { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import type { createHarnessRefinerBenchmarkService } from "./harness-refiner-benchmark-service.js";
import type { createPreferenceComparisonService } from "./preference-comparison-service.js";
import { trainingRunDetail } from "./run-detail.js";
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
}) {
  async function request(action: string, payload: unknown, requestUrl?: URL): Promise<unknown> {
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
    if (action === "preference_comparison_publish") {
      const preferenceComparisons = requirePreferenceComparisons(deps.preferenceComparisons);
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const taskset = await requireTaskset(deps.store, tasksetId);
      return preferenceComparisons.publishRelease({
        tasksetId,
        tasksetRelease: await requireReleasedTaskset(deps.benchmarkTasksets, taskset),
        release: PreferenceComparisonReleaseSchema.parse(input.release),
        publisherKey: requiredString(input.publisherKey, "publisherKey"),
        retentionUntil: nullableString(input.retentionUntil),
      });
    }
    if (action === "preference_comparison_create_assignment") {
      const preferenceComparisons = requirePreferenceComparisons(deps.preferenceComparisons);
      const tasksetId = requiredString(input.tasksetId, "tasksetId");
      const taskset = await requireTaskset(deps.store, tasksetId);
      return preferenceComparisons.createAssignment({
        id: requiredString(input.id, "id"),
        tasksetId,
        tasksetRelease: await requireReleasedTaskset(deps.benchmarkTasksets, taskset),
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
    if (action === "save_model_project") {
      const project = ModelProjectSchema.parse(input);
      const existing = await deps.store.getModelProject(project.id);
      if (existing && existing.profileId !== project.profileId) {
        throw new Error("Model profile does not match the active Profile.");
      }
      return deps.store.saveModelProject({
        ...project,
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
    if (action === "start_model_run") return deps.training.startModelRun({
      modelRunId: requiredString(input.modelRunId, "modelRunId"),
      maximumSpendUsd: nullableNumber(input.maximumSpendUsd),
      retentionDays: nullableNumber(input.retentionDays),
      exportApproved: input.exportApproved === true,
      manifest: input.manifest,
    });
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
async function requireReleasedTaskset(
  benchmarkTasksets: BenchmarkTasksets,
  taskset: Awaited<ReturnType<typeof requireTaskset>>,
): Promise<TasksetRelease> {
  const release = await benchmarkTasksets.releaseForTaskset(taskset);
  if (!release) throw new Error("Taskset must have an immutable execution release before creating preference comparisons.");
  return release;
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
