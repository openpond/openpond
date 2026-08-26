import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  TaskDataRecordSchema,
  TasksetDraftSchema,
  TasksetSchema,
  type DatasetBuildIntent,
  type Taskset,
  type TasksetDraft,
  type TasksetSourceRef,
} from "@openpond/contracts";

import { canonicalJson } from "./canonical-json.js";
import { contentHash } from "./hashing.js";
import { computeTasksetHash, validateTaskset } from "./validation.js";

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
  id?: string;
  name?: string;
  now?: string;
}): TasksetDraft {
  const timestamp = input.now ?? new Date().toISOString();
  const id = input.id?.trim() || `taskset-draft-${randomUUID()}`;
  return TasksetDraftSchema.parse({
    schemaVersion: "openpond.tasksetDraft.v1",
    id,
    revision: 1,
    profileId: input.profileId,
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

  const tasksetId = input.tasksetId?.trim()
    || draft.publishedTasksetRef?.id
    || draft.id.replace(/-draft$/, "");
  const revision = draft.publishedTasksetRef?.id === tasksetId
    ? draft.publishedTasksetRef.revision + 1
    : 1;
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
  const authoredMethod = draft.capabilities.compatibleMethods.find(
    (method) => method !== "none" && method !== "retrieval",
  ) ?? null;
  const buildIntent = buildIntentForDraft(draft);
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
    capabilities: draft.capabilities,
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

export async function writeTasksetDraftPackage(
  draftInput: unknown,
  directory: string,
): Promise<{ directory: string; files: string[]; draft: TasksetDraft }> {
  let draft = TasksetDraftSchema.parse(draftInput);
  const folders = [
    "tasks",
    "assets",
    "environment",
    "graders",
    "rubrics",
    "comparisons",
    "metrics",
    "fixtures",
  ];
  await Promise.all(folders.map((folder) => mkdir(path.join(directory, folder), { recursive: true })));
  const starterFiles = await writeConfiguredStarterCode(draft, directory);
  if (draft.metrics.customAggregator) {
    const aggregatorPath = path.join(directory, draft.metrics.customAggregator.module);
    const contentHash = createHash("sha256")
      .update(await readFile(aggregatorPath))
      .digest("hex");
    draft = TasksetDraftSchema.parse({
      ...draft,
      metrics: {
        ...draft.metrics,
        customAggregator: { ...draft.metrics.customAggregator, contentHash },
      },
    });
  }
  const manifestPath = path.join(directory, "taskset.json");
  const tasksPath = path.join(directory, "tasks", "tasks.jsonl");
  const gradersPath = path.join(directory, "graders", "graders.json");
  const fixturesPath = path.join(directory, "fixtures", "grader-fixtures.json");
  const metricsPath = path.join(directory, "metrics", "policy.json");
  const assetsPath = path.join(directory, "assets", "manifest.json");
  const environmentPath = path.join(directory, "environment", "contract.json");
  const reviewRubricPath = path.join(directory, "rubrics", "preference-review.md");
  const comparisonPath = path.join(directory, "comparisons", "policy.json");
  await Promise.all([
    writeFile(manifestPath, canonicalJson(draft), "utf8"),
    writeFile(tasksPath, jsonLines(draft.tasks), "utf8"),
    writeFile(gradersPath, canonicalJson(draft.graders), "utf8"),
    writeFile(fixturesPath, canonicalJson(draft.graderFixtures), "utf8"),
    writeFile(metricsPath, canonicalJson(draft.metrics), "utf8"),
    writeFile(
      assetsPath,
      canonicalJson(draft.tasks.flatMap((task) => task.assets ?? [])),
      "utf8",
    ),
    writeFile(environmentPath, canonicalJson(draft.environment), "utf8"),
    writeFile(reviewRubricPath, rubricMarkdown(draft), "utf8"),
    writeFile(comparisonPath, canonicalJson(draft.review), "utf8"),
  ]);
  return {
    directory,
    files: [
      manifestPath,
      tasksPath,
      assetsPath,
      environmentPath,
      gradersPath,
      reviewRubricPath,
      comparisonPath,
      metricsPath,
      fixturesPath,
      ...starterFiles,
    ],
    draft,
  };
}

export async function hashTasksetDraftPackage(directory: string): Promise<string> {
  const files = await packageFiles(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(directory, file).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readTasksetDraftPackage(source: string): Promise<TasksetDraft> {
  const manifestPath = path.basename(source) === "taskset.json"
    ? source
    : path.join(source, "taskset.json");
  const directory = path.dirname(manifestPath);
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const draft = TasksetDraftSchema.safeParse(parsed);
  if (draft.success) {
    const [tasks, graders, fixtures, metrics, environment, review] = await Promise.all([
      readOptionalJsonLines(path.join(directory, "tasks", "tasks.jsonl")),
      readOptionalJson(path.join(directory, "graders", "graders.json")),
      readOptionalJson(path.join(directory, "fixtures", "grader-fixtures.json")),
      readOptionalJson(path.join(directory, "metrics", "policy.json")),
      readOptionalJson(path.join(directory, "environment", "contract.json")),
      readOptionalJson(path.join(directory, "comparisons", "policy.json")),
    ]);
    return TasksetDraftSchema.parse({
      ...draft.data,
      ...(tasks === null ? {} : { tasks }),
      ...(graders === null ? {} : { graders }),
      ...(fixtures === null ? {} : { graderFixtures: fixtures }),
      ...(metrics === null ? {} : { metrics }),
      ...(environment === null ? {} : { environment }),
      ...(review === null ? {} : { review }),
    });
  }
  return tasksetDraftFromTaskset(parsed);
}

function draftPublishIssues(draft: TasksetDraft): TasksetDraftPublishIssue[] {
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
  return "demonstrations";
}

function tasksetOutputContract(metadata: Record<string, unknown>): TasksetDraft["output"] {
  const value = metadata.tasksetOutputContract;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as TasksetDraft["output"];
  }
  return { mode: "text", jsonSchema: null, renderer: null };
}

function rubricMarkdown(draft: TasksetDraft): string {
  const criteria = draft.review.criteria.length
    ? `\n\n## Criteria\n\n${draft.review.criteria.map((criterion) =>
      `- **${criterion.label}** (${criterion.weight}): ${criterion.description}`
    ).join("\n")}`
    : "";
  return `# Preference review rubric\n\n${draft.review.rubric}${criteria}\n`;
}

async function writeConfiguredStarterCode(
  draft: TasksetDraft,
  directory: string,
): Promise<string[]> {
  const configured: Array<{ relativePath: string; source: string }> = [];
  if (draft.output.renderer) {
    configured.push({
      relativePath: draft.output.renderer.module,
      source: `export async function ${draft.output.renderer.exportName}(output: unknown) {\n  // Return artifact paths or bytes derived from the model's structured output.\n  return output;\n}\n`,
    });
  }
  for (const grader of draft.graders) {
    if (grader.kind !== "custom_verifier") continue;
    configured.push({
      relativePath: grader.module,
      source: `export async function ${grader.exportName}(input: { output: unknown; task: unknown }) {\n  return { passed: false, score: 0, feedback: "Implement this verifier." };\n}\n`,
    });
  }
  if (draft.metrics.customAggregator) {
    configured.push({
      relativePath: draft.metrics.customAggregator.module,
      source: `export function ${draft.metrics.customAggregator.exportName}(scores: number[]) {\n  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;\n}\n`,
    });
  }
  const written: string[] = [];
  for (const item of configured) {
    const file = path.join(directory, item.relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, item.source, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isFileExists(error)) throw error;
    }
    written.push(file);
  }
  return written;
}

async function packageFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Taskset workspaces cannot contain symbolic links: ${target}`);
      }
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(directory);
  return files;
}

function jsonLines(values: unknown[]): string {
  return values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

async function readOptionalJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readOptionalJsonLines(file: string): Promise<unknown[] | null> {
  try {
    const content = await readFile(file, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
