import { TasksetDraftSchema, type TasksetDraft } from "./taskset-draft-document.js";

export type TasksetDraftPublishIssue = {
  code: string;
  message: string;
  path: string | null;
};

export class TasksetDraftPublishError extends Error {
  readonly issues: TasksetDraftPublishIssue[];

  constructor(issues: TasksetDraftPublishIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "TasksetDraftPublishError";
    this.issues = issues;
  }
}

export function createTasksetDraft(input: {
  profileId: string;
  modelScope?: TasksetDraft["modelScope"];
  id?: string;
  name?: string;
  now?: string;
}): TasksetDraft {
  const timestamp = input.now ?? new Date().toISOString();
  const id = input.id?.trim() || `taskset-draft-${globalThis.crypto.randomUUID()}`;
  return TasksetDraftSchema.parse({
    schemaVersion: "openpond.tasksetDraft.v1",
    id,
    revision: 1,
    profileId: input.profileId,
    modelScope: input.modelScope ?? null,
    name: input.name?.trim() ?? "",
    objective: "",
    purpose: "general",
    benchmark: null,
    preferenceComparison: null,
    status: "draft",
    sourceRefs: [],
    datasetArtifact: null,
    policy: {
      policyVisibleFields: ["input"],
      privilegedFields: ["expectedOutput"],
      hiddenGraderRefs: [],
      connectedAppScopes: [],
    },
    environment: {
      protocolVersion: "openpond.taskEnvironment.v1",
      kind: "chat",
      entrypoint: "openpond-chat-v1",
      stateful: false,
      deterministicSeeds: true,
      toolNames: [],
      lifecycle: ["create", "reset", "step", "grade", "cleanup"],
      defaultTimeoutMs: 120_000,
      networkPolicy: "none",
      resources: [],
      metadata: {},
    },
    output: {
      mode: "text",
      jsonSchema: null,
      renderer: null,
    },
    capabilities: {
      schemaVersion: "openpond.tasksetCapabilities.v1",
      taskKind: "chat",
      supportedSignals: [
        "demonstration",
        "preference",
        "correction",
        "feedback",
        "reward",
        "label",
      ],
      compatibleMethods: ["none"],
      rewardKinds: ["none"],
      requiresTools: false,
      requiresState: false,
      requiresPrivilegedGrading: true,
      environmentPlacements: ["local", "remote", "colocated"],
      exportable: true,
      portabilityBlockers: [],
    },
    metrics: {
      schemaVersion: "openpond.tasksetMetricPolicy.v1",
      primaryMetric: "score",
      aggregation: "mean_score",
      missingReward: "zero",
      customAggregator: null,
    },
    review: {
      enabled: false,
      candidateCount: 2,
      minimumSamples: 100,
      allowTies: true,
      allowRejectAll: true,
      rubric: "",
      criteria: [],
    },
    tasks: [],
    graders: [],
    graderFixtures: [],
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
    publishedTasksetRef: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  });
}

export function draftPublishIssues(draft: TasksetDraft): TasksetDraftPublishIssue[] {
  const issues: TasksetDraftPublishIssue[] = [];
  if (!draft.name.trim()) issues.push({ code: "name_missing", message: "Name is required.", path: "name" });
  if (!draft.objective.trim()) issues.push({ code: "objective_missing", message: "Objective is required.", path: "objective" });
  if (!draft.datasetArtifact && draft.tasks.length === 0) issues.push({ code: "tasks_missing", message: "Add at least one task or Dataset artifact.", path: "tasks" });
  if (draft.graders.length === 0) issues.push({ code: "graders_missing", message: "Add at least one grader.", path: "graders" });
  if (draft.graderFixtures.length === 0) issues.push({ code: "grader_fixtures_missing", message: "Add grader fixtures before publishing.", path: "graderFixtures" });
  const sourceIds = new Set(draft.sourceRefs.map((source) => source.id));
  for (const task of draft.tasks) {
    for (const sourceId of task.sourceRefs) {
      if (!sourceIds.has(sourceId)) issues.push({ code: "task_source_missing", message: `Task ${task.id} references missing source ${sourceId}.`, path: `tasks.${task.id}.sourceRefs` });
    }
  }
  return issues;
}
