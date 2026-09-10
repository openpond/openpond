import { contentHash } from "@openpond/harness";
import { TasksetSchema, type Taskset, type DatasetBuildIntent } from "./taskset-authored-contracts.js";
import { TaskDataRecordSchema, type TasksetSourceRef } from "./taskset-draft-core.js";
import { TasksetDraftSchema, type TasksetDraft } from "./taskset-draft-document.js";
import { draftPublishIssues, TasksetDraftPublishError } from "./taskset-draft-authoring.js";
import { computeTasksetHash, validateTaskset } from "./taskset-authored-validation.js";

export function tasksetDraftFromTaskset(
  tasksetInput: unknown,
  now = new Date().toISOString(),
): TasksetDraft {
  const taskset = TasksetSchema.parse(tasksetInput);
  return TasksetDraftSchema.parse({
    schemaVersion: "openpond.tasksetDraft.v1",
    id: `${taskset.id}-draft`,
    revision: 1,
    profileId: taskset.profileId,
    name: taskset.name,
    objective: taskset.objective,
    purpose: taskset.purpose,
    benchmark: taskset.benchmark,
    preferenceComparison: taskset.preferenceComparison,
    status: "draft",
    sourceRefs: taskset.sourceRefs,
    datasetArtifact: taskset.datasetArtifact ?? null,
    policy: taskset.policy,
    environment: taskset.environment,
    output: tasksetOutputContract(taskset.metadata),
    capabilities: taskset.capabilities,
    metrics: taskset.metrics ?? {
      schemaVersion: "openpond.tasksetMetricPolicy.v1",
      primaryMetric: "score",
      aggregation: "mean_score",
      missingReward: "zero",
      customAggregator: null,
    },
    review: {
      enabled: Boolean(taskset.preferenceComparison),
      candidateCount: 2,
      minimumSamples: 100,
      allowTies: true,
      allowRejectAll: true,
      rubric: "",
      criteria: [],
    },
    tasks: taskset.tasks,
    graders: taskset.graders,
    graderFixtures: taskset.graderFixtures,
    learningSignals: taskset.learningSignals,
    publishedTasksetRef: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    createdAt: now,
    updatedAt: now,
    metadata: {
      ...taskset.metadata,
      importedFromTaskset: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
    },
  });
}

export function publishTasksetDraft(input: {
  draft: unknown;
  now?: string;
  tasksetId?: string;
  sourcePackageHash?: string;
}): Taskset {
  const draft = TasksetDraftSchema.parse(input.draft);
  const timestamp = input.now ?? new Date().toISOString();
  const issues = draftPublishIssues(draft);
  if (issues.length) throw new TasksetDraftPublishError(issues);

  const preparedSource = draft.modelScope?.source;
  if (preparedSource && input.tasksetId && input.tasksetId !== preparedSource.tasksetId) throw new Error("Taskset draft publication differs from its prepared identity.");
  const tasksetId = preparedSource?.tasksetId || input.tasksetId?.trim()
    || draft.publishedTasksetRef?.id
    || draft.id.replace(/-draft$/, "");
  const revision = preparedSource?.tasksetRevision ?? (draft.publishedTasksetRef?.id === tasksetId
    ? draft.publishedTasksetRef.revision + 1
    : 1);
  const sourceRefs = draft.sourceRefs.length
    ? draft.sourceRefs
    : [generatedDraftSource(draft, tasksetId, timestamp)];
  const defaultSourceId = sourceRefs[0]!.id;
  const tasks = draft.tasks.map((task) => TaskDataRecordSchema.parse({
    ...task,
    sourceRefs: task.sourceRefs.length ? task.sourceRefs : [defaultSourceId],
    metadata: {
      exampleOrigin: "expert_authored",
      ...task.metadata,
    },
  }));
  const explicitMethod = draft.capabilities.compatibleMethods.find(
    (method) => method !== "none" && method !== "retrieval",
  ) ?? null;
  const buildIntent = buildIntentForDraft(draft);
  const rewardGraders = draft.graders.filter(grader => grader.rewardEligible && grader.weight > 0 && grader.kind !== "human");
  const inferRewardMethod = explicitMethod === null && buildIntent === "verifiable_reward" && rewardGraders.length > 0;
  const authoredMethod = explicitMethod ?? (inferRewardMethod ? "grpo" : null);
  const taskset = TasksetSchema.parse({
    schemaVersion: "openpond.taskset.v1",
    id: tasksetId,
    revision,
    profileId: draft.profileId,
    profileRelease: null,
    createImproveRunId: null,
    name: draft.name,
    objective: draft.objective,
    purpose: draft.purpose,
    benchmark: draft.benchmark,
    preferenceComparison: draft.preferenceComparison,
    status: "needs_review",
    sourceRefs,
    datasetArtifact: draft.datasetArtifact ?? null,
    policy: draft.policy,
    environment: draft.environment,
    capabilities: inferRewardMethod ? { ...draft.capabilities, compatibleMethods: ["grpo"],
      rewardKinds: [...new Set(rewardGraders.map(grader => grader.kind === "model_judge" ? "model_judge" : "deterministic"))] } : draft.capabilities,
    metrics: draft.metrics,
    tasks,
    graders: draft.graders,
    graderFixtures: draft.graderFixtures,
    learningSignals: draft.learningSignals,
    authoringProvenance: {
      schemaVersion: "openpond.taskAuthoringProvenance.v1",
      model: null,
      modelConfig: {},
      skillHash: contentHash("openpond-taskset-draft-authoring-v1"),
      promptTemplateVersion: "taskset-draft-v1",
      buildIntent,
      buildSpecification: null,
      evidenceHashes: sourceRefs.map((source) => source.sourceHash),
      tasksetSdkVersion: "draft-v1",
      sourceCommit: null,
      repairHistory: [],
      createdAt: timestamp,
    },
    readiness: null,
    contentHash: "00000000",
    createdAt: revision === 1 ? draft.createdAt : timestamp,
    updatedAt: timestamp,
    metadata: {
      ...draft.metadata,
      ...(preparedSource ? { modelTasksetAuthoring: preparedSource.lineage } : {}),
      tasksetReviewPolicy: draft.review,
      tasksetOutputContract: draft.output,
      ...(input.sourcePackageHash
        ? { sourcePackageHash: input.sourcePackageHash }
        : {}),
      ...(authoredMethod ? { trainingMethod: authoredMethod } : {}),
      diagnosis: {
        schemaVersion: "openpond.capabilityDiagnosis.v1",
        summary: draft.objective,
        stableBehavior: [draft.objective],
        changingKnowledge: [],
        requiredContext: [],
        requiredTools: draft.environment.toolNames,
        intervention: authoredMethod === "dpo"
          ? "preference"
          : authoredMethod === "grpo" || authoredMethod === "ppo"
            ? "grpo_rft"
            : authoredMethod === "sft" ? "sft" : "no_training",
        trainingEligible: authoredMethod !== null,
        rationale: authoredMethod
          ? [`The author selected ${authoredMethod.toUpperCase()} compatibility.`]
          : ["The Taskset is currently configured for evaluation only."],
        confidence: 1,
      },
    },
  });
  const hashed = TasksetSchema.parse({
    ...taskset,
    contentHash: computeTasksetHash(taskset),
  });
  const report = validateTaskset(hashed);
  const validationErrors = report.issues.filter((issue) => issue.severity === "error");
  if (validationErrors.length) {
    throw new TasksetDraftPublishError(validationErrors.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
    })));
  }
  return hashed;
}

function generatedDraftSource(
  draft: TasksetDraft,
  tasksetId: string,
  timestamp: string,
): TasksetSourceRef {
  const generatorHash = contentHash({
    draftId: draft.id,
    draftRevision: draft.revision,
    tasks: draft.tasks,
  });
  return {
    schemaVersion: "openpond.generatedDatasetSource.v1",
    kind: "generated",
    id: `source-${tasksetId}`,
    profileId: draft.profileId,
    title: `${draft.name} manual authoring`,
    sourceHash: generatorHash,
    occurredAt: timestamp,
    licensingStatus: "approved",
    secretScanStatus: "passed",
    piiScanStatus: "passed",
    generatorId: "openpond-taskset-draft",
    generatorVersion: "1",
    seed: 0,
    generatorHash,
    metadata: { draftId: draft.id, draftRevision: draft.revision },
  };
}

function buildIntentForDraft(draft: TasksetDraft): DatasetBuildIntent {
  if (draft.learningSignals.preferences.length) return "preferences";
  if (draft.learningSignals.rewards.length) return "verifiable_reward";
  if (draft.learningSignals.labels.length) return "rubric";
  if (!draft.capabilities.compatibleMethods.some(method => method !== "none" && method !== "retrieval")
    && draft.graders.some(grader => grader.rewardEligible && grader.weight > 0 && grader.kind !== "human")) return "verifiable_reward";
  return "demonstrations";
}

function tasksetOutputContract(metadata: Record<string, unknown>): TasksetDraft["output"] {
  const value = metadata.tasksetOutputContract;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as TasksetDraft["output"];
  }
  return { mode: "text", jsonSchema: null, renderer: null };
}
