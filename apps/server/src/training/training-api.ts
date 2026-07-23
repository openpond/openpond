import {
  BaseModelPreferenceSchema,
  ChatModelRefSchema,
  CodexReasoningEffortSchema,
  ApproveDatasetImportMappingRequestSchema,
  CreateHuggingFaceDatasetImportRequestSchema,
  DatasetCatalogResponseSchema,
  ModelBuildDraftSchema,
  nextCreateImproveRunRevision,
  PatchTaskCandidateRequestSchema,
  RunTaskMinerRequestSchema,
  TaskCreationRequestSchema,
  TaskMinerConfigSchema,
  TrainingDestinationIdSchema,
  TrainingChatSearchRequestSchema,
  type BaseModelPreference,
  type ChatModelRef,
  type CrossSystemWorldSpec,
  type TaskCreationRequest,
  type TaskCreationSnapshot,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { createTaskCreatorService } from "./task-creator.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createTaskMinerService } from "./task-miner.js";
import type { createTrainingService } from "./training-service.js";
import type { createTrainingChatSearchService } from "./training-chat-search.js";
import type { createDatasetArtifactService } from "./dataset-artifact-service.js";
import type { createDatasetImportService } from "./dataset-imports/import-service.js";
import { trainingRunDetail } from "./run-detail.js";
import { scriptedOpenPondModelsEnabled } from "../openpond/scripted-chat-provider.js";
import { recordFixtureBaselineSources } from "./cross-system-operations/index.js";
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

type TaskCreator = ReturnType<typeof createTaskCreatorService>;
type TaskMiner = ReturnType<typeof createTaskMinerService>;
type Evaluation = ReturnType<typeof createTaskEvaluationService>;
type Training = ReturnType<typeof createTrainingService>;
type StartedTrainingResult = Awaited<ReturnType<Training["start"]>>;
type TrainingChatSearch = ReturnType<typeof createTrainingChatSearchService>;
type DatasetArtifacts = ReturnType<typeof createDatasetArtifactService>;
type DatasetImports = ReturnType<typeof createDatasetImportService>;

export function createTrainingApi(deps: {
  store: SqliteStore;
  taskCreator: TaskCreator;
  taskMiner: TaskMiner;
  evaluation: Evaluation;
  training: Training;
  chatSearch: TrainingChatSearch;
  datasetArtifacts: DatasetArtifacts;
  datasetImports: DatasetImports;
  frontierBaseline: {
    startRun: (input: {
      profileId: string;
      createImproveRunId?: string | null;
      localProjectId: string;
      worldSpecs: CrossSystemWorldSpec[];
      model: ChatModelRef;
      reasoningEffort: ReturnType<typeof CodexReasoningEffortSchema.parse> | null;
    }) => Promise<unknown>;
    cancelRun: (id: string) => Promise<unknown>;
  };
}) {
  async function request(action: string, payload: unknown, requestUrl?: URL): Promise<unknown> {
    const input = record(payload);
    if (action === "state") return state(string(input.profileId) ?? requestUrl?.searchParams.get("profileId") ?? "default");
    if (action === "dataset_catalog") {
      return datasetCatalog(
        string(input.profileId)
          ?? requestUrl?.searchParams.get("profileId")
          ?? "default",
      );
    }
    if (action === "save_model_build_draft") {
      const draft = ModelBuildDraftSchema.parse(input);
      const existing = await deps.store.getModelBuildDraft(draft.id);
      if (existing && existing.profileId !== draft.profileId) {
        throw new Error("Model build draft profile does not match the active Profile.");
      }
      if (existing && existing.modelId !== draft.modelId) {
        throw new Error("A saved Model build draft cannot change Model identity.");
      }
      return deps.store.saveModelBuildDraft({
        ...draft,
        createdAt: existing?.createdAt ?? draft.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    if (action === "delete_model_build_draft") {
      const draft = await deps.store.getModelBuildDraft(
        requiredString(input.draftId, "draftId"),
      );
      if (!draft) return { deleted: false };
      await deps.store.deleteModelBuildDraft(draft.id);
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
    if (action === "run_cross_system_frontier_baseline") {
      return deps.frontierBaseline.startRun({
        profileId: requiredString(input.profileId, "profileId"),
        createImproveRunId: string(input.createImproveRunId),
        localProjectId: requiredString(input.localProjectId, "localProjectId"),
        worldSpecs: crossSystemWorldSpecs(input.worldSpecs),
        model: ChatModelRefSchema.parse(input.model),
        reasoningEffort: input.reasoningEffort ? CodexReasoningEffortSchema.parse(input.reasoningEffort) : null,
      });
    }
    if (action === "cancel_cross_system_frontier_baseline") return deps.frontierBaseline.cancelRun(requiredString(input.runId, "runId"));
    if (action === "record_cross_system_fixture_baseline") {
      if (!scriptedOpenPondModelsEnabled()) throw new Error("The deterministic fixture baseline is available only in desktop harness mode.");
      return recordFixtureBaselineSources({
        store: deps.store,
        profileId: requiredString(input.profileId, "profileId"),
        sourceIds: requiredStringArray(input.sourceIds, "sourceIds"),
        worldSpecs: crossSystemWorldSpecs(input.worldSpecs),
        model: ChatModelRefSchema.parse(input.model),
        approvedBy: string(input.approvedBy) ?? undefined,
      });
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
      if (creation.state === "ready" && creation.materializedTasksetId) await deps.evaluation.readiness(creation.materializedTasksetId);
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
    if (action === "baseline") return deps.evaluation.startBaseline({
      tasksetId: requiredString(input.tasksetId, "tasksetId"),
      targetModelId: string(input.targetModelId),
      models: modelRefs(input.models),
      seeds: numberArray(input.seeds),
      attemptsPerTask: number(input.attemptsPerTask),
      taskLimit: number(input.taskLimit),
      selectionSeed: number(input.selectionSeed),
      split: baselineSplit(input.split),
      selectionStrategy: baselineSelectionStrategy(input.selectionStrategy),
      sampling: baselineSampling(input.sampling),
    });
    if (action === "cancel_baseline_run") {
      return deps.evaluation.cancelBaselineRun(
        requiredString(input.runId, "runId"),
      );
    }
    if (action === "regrade_baseline") return deps.evaluation.regradeBaseline({ tasksetId: requiredString(input.tasksetId, "tasksetId"), baselineReportId: requiredString(input.baselineReportId, "baselineReportId") });
    if (action === "audit_graders") return deps.evaluation.auditFixtures({ tasksetId: requiredString(input.tasksetId, "tasksetId"), fixtures: Array.isArray(input.fixtures) ? input.fixtures as never[] : undefined });
    if (action === "calibrate_judges") return deps.evaluation.calibrateModelJudges(requiredString(input.tasksetId, "tasksetId"));
    if (action === "readiness") return deps.evaluation.readiness(requiredString(input.tasksetId, "tasksetId"));
    if (action === "preview_expert_bootstrap") return deps.training.previewExpertBootstrap(requiredString(input.tasksetId, "tasksetId"));
    if (action === "approve_expert_bootstrap") return deps.training.approveExpertBootstrap({
      tasksetId: requiredString(input.tasksetId, "tasksetId"),
      previewHash: requiredString(input.previewHash, "previewHash"),
    });
    if (action === "create_plan") return deps.training.createPlan({ modelId: requiredString(input.modelId, "modelId"), tasksetId: requiredString(input.tasksetId, "tasksetId"), destinationId: TrainingDestinationIdSchema.parse(input.destinationId), recipe: input.recipe, exportApproved: input.exportApproved === true, retentionDays: nullableNumber(input.retentionDays), region: string(input.region) });
    if (action === "build_bundle") return deps.training.buildBundle(requiredString(input.planId, "planId"));
    if (action === "approve_training") return deps.training.approve({ planId: requiredString(input.planId, "planId"), bundleId: requiredString(input.bundleId, "bundleId"), approvedBy: string(input.approvedBy) ?? undefined, maximumCostUsd: nullableNumber(input.maximumCostUsd) });
    if (action === "launch") return deps.training.launch({ planId: requiredString(input.planId, "planId"), approvalId: requiredString(input.approvalId, "approvalId") });
    if (action === "prepare_start") return deps.training.prepareStart({
      modelId: requiredString(input.modelId, "modelId"),
      tasksetId: requiredString(input.tasksetId, "tasksetId"),
      destinationId: TrainingDestinationIdSchema.parse(input.destinationId),
      recipe: input.recipe,
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
    if (action === "start") {
      const result = await deps.training.start({ modelId: requiredString(input.modelId, "modelId"), tasksetId: requiredString(input.tasksetId, "tasksetId"), destinationId: TrainingDestinationIdSchema.parse(input.destinationId), recipe: input.recipe, exportApproved: input.exportApproved === true, maximumCostUsd: nullableNumber(input.maximumCostUsd), retentionDays: nullableNumber(input.retentionDays), region: string(input.region) });
      return linkStartedTraining(result);
    }
    if (action === "import_artifact") return deps.training.importExternal({ planId: requiredString(input.planId, "planId"), bundleId: requiredString(input.bundleId, "bundleId"), artifactDirectory: requiredString(input.artifactDirectory, "artifactDirectory") });
    if (action === "export_bundle") return deps.training.exportBundle(requiredString(input.bundleId, "bundleId"));
    if (action === "artifact_download") return deps.training.artifactDownload(requiredString(input.artifactId, "artifactId"));
    if (action === "model_package_download") return deps.training.modelPackageDownload(requiredString(input.modelId, "modelId"));
    if (action === "start_model_serving") return deps.training.startModelServing({
      profileId: requiredString(input.profileId, "profileId"),
      modelId: requiredString(input.modelId, "modelId"),
    });
    if (action === "stop_model_serving") return deps.training.stopModelServing(
      requiredString(input.servingSessionId, "servingSessionId"),
      "user",
    );
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
    if (action === "evaluate_job") return deps.training.evaluateJob(requiredString(input.jobId, "jobId"));
    if (action === "save_credential") return deps.training.saveCredential({ destinationId: requiredString(input.destinationId, "destinationId"), value: requiredString(input.value, "value") });
    if (action === "job_events") return deps.store.listTrainingJobEvents(requiredString(input.jobId, "jobId"));
    if (action === "run_detail") return trainingRunDetail(deps.store, requiredString(input.jobId, "jobId"));
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
    const [sources, creations, tasksets, datasetImports, datasetArtifacts, candidates, minerConfig, minerRuns, frontierBaselineRuns, baselineRuns, modelBuildDrafts, execution] = await Promise.all([
      deps.store.listTrainingSources(profileId),
      deps.store.listTaskCreationSnapshots(profileId),
      deps.store.listTasksets(profileId),
      deps.store.listDatasetImportJobs(profileId),
      deps.datasetArtifacts.summaries(profileId),
      deps.store.listTaskCandidates(profileId, "all"),
      deps.taskMiner.config(profileId),
      deps.store.listTaskMinerRuns(profileId),
      deps.store.listCrossSystemFrontierBaselineRuns(profileId),
      deps.store.listTasksetBaselineRuns({ profileId }),
      deps.store.listModelBuildDrafts(profileId),
      deps.training.state(profileId),
    ]);
    await syncModelTrainingCreateImproveRuns({ store: deps.store, profileId, execution });
    const baselineReports = (await Promise.all(tasksets.map((taskset) => deps.store.listBaselineReports(taskset.id)))).flat();
    const graderAuditReports = (await Promise.all(tasksets.map((taskset) => deps.store.listGraderAuditReports(taskset.id)))).flat();
    return { schemaVersion: "openpond.trainingState.v1", profileId, sources, creations, tasksets, datasetImports, datasetArtifacts, baselineReports, baselineRuns, graderAuditReports, candidates, minerConfig, minerRuns, frontierBaselineRuns, modelBuildDrafts, ...execution, generatedAt: new Date().toISOString() };
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

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requiredString(value: unknown, name: string): string { const parsed = string(value); if (!parsed) throw new Error(`${name} is required.`); return parsed; }
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
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : []; }
function modelRefs(value: unknown): ChatModelRef[] { if (!Array.isArray(value) || !value.length) throw new Error("At least one baseline model is required."); return value.map((item) => ChatModelRefSchema.parse(item)); }
function baselineSplit(value: unknown): "train" | "validation" | "frozen_eval" | undefined { return value === "train" || value === "validation" || value === "frozen_eval" ? value : undefined; }
function baselineSelectionStrategy(value: unknown): "stable_hash_top_n" | "rft_easy_curriculum_v1" | undefined { return value === "stable_hash_top_n" || value === "rft_easy_curriculum_v1" ? value : undefined; }
function baselineSampling(value: unknown): { maxOutputTokens?: number; temperature?: number; topP?: number } | undefined {
  const candidate = record(value);
  const sampling = {
    maxOutputTokens: number(candidate.maxOutputTokens),
    temperature: number(candidate.temperature),
    topP: number(candidate.topP),
  };
  return Object.values(sampling).some((item) => item !== undefined)
    ? sampling
    : undefined;
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
function crossSystemWorldSpecs(value: unknown): CrossSystemWorldSpec[] {
  if (!Array.isArray(value)) throw new Error("worldSpecs must be an array.");
  return value.map((item) => {
    const candidate = record(item);
    const seed = number(candidate.seed);
    const split = candidate.split;
    const difficulty = candidate.difficulty;
    if (!Number.isInteger(seed) || (split !== "train" && split !== "validation" && split !== "frozen_eval") || (difficulty !== "easy" && difficulty !== "medium" && difficulty !== "hard")) {
      throw new Error("Each world spec requires an integer seed, valid split, and valid difficulty.");
    }
    return { seed: seed!, split, difficulty } as CrossSystemWorldSpec;
  });
}
