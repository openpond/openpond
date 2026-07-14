import {
  ChatModelRefSchema,
  CodexReasoningEffortSchema,
  PatchTaskCandidateRequestSchema,
  RunTaskMinerRequestSchema,
  TaskMinerConfigSchema,
  TrainingDestinationIdSchema,
  TrainingChatSearchRequestSchema,
  type ChatModelRef,
  type TaskCreationRequest,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { createTaskCreatorService } from "./task-creator.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import type { createTaskMinerService } from "./task-miner.js";
import type { createTrainingService } from "./training-service.js";
import type { createTrainingChatSearchService } from "./training-chat-search.js";
import { trainingRunDetail } from "./run-detail.js";
import { scriptedOpenPondModelsEnabled } from "../openpond/scripted-chat-provider.js";
import { recordFixtureBaselineSources, type CrossSystemWorldSpec } from "./cross-system-operations/index.js";

type TaskCreator = ReturnType<typeof createTaskCreatorService>;
type TaskMiner = ReturnType<typeof createTaskMinerService>;
type Evaluation = ReturnType<typeof createTaskEvaluationService>;
type Training = ReturnType<typeof createTrainingService>;
type TrainingChatSearch = ReturnType<typeof createTrainingChatSearchService>;

export function createTrainingApi(deps: {
  store: SqliteStore;
  taskCreator: TaskCreator;
  taskMiner: TaskMiner;
  evaluation: Evaluation;
  training: Training;
  chatSearch: TrainingChatSearch;
  runCrossSystemFrontierBaseline: (input: {
    profileId: string;
    worldSpecs: CrossSystemWorldSpec[];
    model: ChatModelRef;
    reasoningEffort: ReturnType<typeof CodexReasoningEffortSchema.parse> | null;
  }) => Promise<unknown>;
}) {
  async function request(action: string, payload: unknown, requestUrl?: URL): Promise<unknown> {
    const input = record(payload);
    if (action === "state") return state(string(input.profileId) ?? requestUrl?.searchParams.get("profileId") ?? "default");
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
    if (action === "run_cross_system_frontier_baseline") {
      return deps.runCrossSystemFrontierBaseline({
        profileId: requiredString(input.profileId, "profileId"),
        worldSpecs: crossSystemWorldSpecs(input.worldSpecs),
        model: ChatModelRefSchema.parse(input.model),
        reasoningEffort: input.reasoningEffort ? CodexReasoningEffortSchema.parse(input.reasoningEffort) : null,
      });
    }
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
    if (action === "start_creation") return deps.taskCreator.start({ profileId: requiredString(input.profileId, "profileId"), sourceIds: stringArray(input.sourceIds), surface: creationSurface(input.surface), mode: input.mode === "customize" ? "customize" : "defaults", entryMode: input.entryMode === "automated" ? "automated" : "manual", objective: string(input.objective), methodHint: trainingMethodHint(input.methodHint), candidateId: string(input.candidateId), analysisModel: input.analysisModel ? ChatModelRefSchema.parse(input.analysisModel) : null, analysisReasoningEffort: input.analysisReasoningEffort ? CodexReasoningEffortSchema.parse(input.analysisReasoningEffort) : null });
    if (action === "approve_disclosure") return deps.taskCreator.approveDisclosure(requiredString(input.creationId, "creationId"), input.approved === true);
    if (action === "answer_questions") return deps.taskCreator.answerQuestions(requiredString(input.creationId, "creationId"), stringRecord(input.answers));
    if (action === "approve_materialization") {
      const creation = await deps.taskCreator.approveMaterialization(requiredString(input.creationId, "creationId"), input.approved === true);
      if (creation.state === "ready" && creation.materializedTasksetId) await deps.evaluation.readiness(creation.materializedTasksetId);
      return creation;
    }
    if (action === "chat_creation") return deps.taskCreator.chat(requiredString(input.creationId, "creationId"), requiredString(input.message, "message"));
    if (action === "rename_creation") return deps.taskCreator.rename(requiredString(input.creationId, "creationId"), requiredString(input.name, "name"));
    if (action === "cancel_creation") return deps.taskCreator.cancel(requiredString(input.creationId, "creationId"));
    if (action === "run_miner") return deps.taskMiner.startRun(RunTaskMinerRequestSchema.parse(input));
    if (action === "cancel_miner_run") return deps.taskMiner.cancelRun(requiredString(input.runId, "runId"));
    if (action === "configure_miner") return deps.taskMiner.updateConfig(requiredString(input.profileId, "profileId"), TaskMinerConfigSchema.parse(input.config));
    if (action === "patch_candidate") return deps.taskMiner.patch(requiredString(input.candidateId, "candidateId"), PatchTaskCandidateRequestSchema.parse(input.patch));
    if (action === "create_candidate") {
      const candidate = await deps.store.getTaskCandidate(requiredString(input.candidateId, "candidateId"));
      if (!candidate) throw new Error("Task Candidate not found.");
      const sourceIds = [...new Set(candidate.evidence.flatMap((item) => item.sourceRefIds))];
      await deps.taskMiner.patch(candidate.id, { status: "creating" });
      return deps.taskCreator.start({ profileId: candidate.profileId, sourceIds, surface: "task_candidate", mode: input.mode === "customize" ? "customize" : "defaults", entryMode: "automated", objective: string(input.objective) ?? candidate.summary, candidateId: candidate.id, analysisModel: input.analysisModel ? ChatModelRefSchema.parse(input.analysisModel) : null, analysisReasoningEffort: input.analysisReasoningEffort ? CodexReasoningEffortSchema.parse(input.analysisReasoningEffort) : null });
    }
    if (action === "grade") return deps.evaluation.grade({ tasksetId: requiredString(input.tasksetId, "tasksetId"), taskId: requiredString(input.taskId, "taskId"), attempt: input.attempt });
    if (action === "baseline") return deps.evaluation.baseline({ tasksetId: requiredString(input.tasksetId, "tasksetId"), models: modelRefs(input.models), seeds: numberArray(input.seeds), attemptsPerTask: number(input.attemptsPerTask) });
    if (action === "audit_graders") return deps.evaluation.auditFixtures({ tasksetId: requiredString(input.tasksetId, "tasksetId"), fixtures: Array.isArray(input.fixtures) ? input.fixtures as never[] : undefined });
    if (action === "calibrate_judges") return deps.evaluation.calibrateModelJudges(requiredString(input.tasksetId, "tasksetId"));
    if (action === "readiness") return deps.evaluation.readiness(requiredString(input.tasksetId, "tasksetId"));
    if (action === "create_plan") return deps.training.createPlan({ tasksetId: requiredString(input.tasksetId, "tasksetId"), destinationId: TrainingDestinationIdSchema.parse(input.destinationId), recipe: input.recipe, exportApproved: input.exportApproved === true, retentionDays: nullableNumber(input.retentionDays), region: string(input.region) });
    if (action === "build_bundle") return deps.training.buildBundle(requiredString(input.planId, "planId"));
    if (action === "approve_training") return deps.training.approve({ planId: requiredString(input.planId, "planId"), bundleId: requiredString(input.bundleId, "bundleId"), approvedBy: string(input.approvedBy) ?? undefined, maximumCostUsd: nullableNumber(input.maximumCostUsd) });
    if (action === "launch") return deps.training.launch({ planId: requiredString(input.planId, "planId"), approvalId: requiredString(input.approvalId, "approvalId") });
    if (action === "start") return deps.training.start({ tasksetId: requiredString(input.tasksetId, "tasksetId"), destinationId: TrainingDestinationIdSchema.parse(input.destinationId), recipe: input.recipe, exportApproved: input.exportApproved === true, maximumCostUsd: nullableNumber(input.maximumCostUsd) });
    if (action === "import_artifact") return deps.training.importExternal({ planId: requiredString(input.planId, "planId"), bundleId: requiredString(input.bundleId, "bundleId"), artifactDirectory: requiredString(input.artifactDirectory, "artifactDirectory") });
    if (action === "export_bundle") return deps.training.exportBundle(requiredString(input.bundleId, "bundleId"));
    if (action === "artifact_download") return deps.training.artifactDownload(requiredString(input.artifactId, "artifactId"));
    if (action === "reject_model") return deps.training.rejectModel({ modelId: requiredString(input.modelId, "modelId"), reason: requiredString(input.reason, "reason") });
    if (action === "update_model_configuration") return deps.training.updateModelConfiguration({ modelId: requiredString(input.modelId, "modelId"), configuration: record(input.configuration) });
    if (action === "cancel_job") return deps.training.registry.get("local_cpu_fixture").cancel(requiredString(input.jobId, "jobId"));
    if (action === "save_credential") return deps.training.saveCredential({ destinationId: requiredString(input.destinationId, "destinationId"), value: requiredString(input.value, "value") });
    if (action === "job_events") return deps.store.listTrainingJobEvents(requiredString(input.jobId, "jobId"));
    if (action === "run_detail") return trainingRunDetail(deps.store, requiredString(input.jobId, "jobId"));
    throw new Error(`Unknown training action ${action}.`);
  }

  async function state(profileId: string) {
    const [sources, creations, tasksets, candidates, minerConfig, minerRuns, execution] = await Promise.all([
      deps.store.listTrainingSources(profileId),
      deps.store.listTaskCreationSnapshots(profileId),
      deps.store.listTasksets(profileId),
      deps.store.listTaskCandidates(profileId, "all"),
      deps.taskMiner.config(profileId),
      deps.store.listTaskMinerRuns(profileId),
      deps.training.state(),
    ]);
    const baselineReports = (await Promise.all(tasksets.map((taskset) => deps.store.listBaselineReports(taskset.id)))).flat();
    const graderAuditReports = (await Promise.all(tasksets.map((taskset) => deps.store.listGraderAuditReports(taskset.id)))).flat();
    return { schemaVersion: "openpond.trainingState.v1", profileId, sources, creations, tasksets, baselineReports, graderAuditReports, candidates, minerConfig, minerRuns, ...execution, generatedAt: new Date().toISOString() };
  }
  return { request, state };
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requiredString(value: unknown, name: string): string { const parsed = string(value); if (!parsed) throw new Error(`${name} is required.`); return parsed; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : []; }
function requiredStringArray(value: unknown, name: string): string[] { const parsed = stringArray(value); if (!parsed.length) throw new Error(`${name} requires at least one value.`); return parsed; }
function stringRecord(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : []; }
function modelRefs(value: unknown): ChatModelRef[] { if (!Array.isArray(value) || !value.length) throw new Error("At least one baseline model is required."); return value.map((item) => ChatModelRefSchema.parse(item)); }
function trainingMethodHint(value: unknown): TaskCreationRequest["methodHint"] { return value === "sft" || value === "dpo" || value === "grpo" ? value : null; }
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
