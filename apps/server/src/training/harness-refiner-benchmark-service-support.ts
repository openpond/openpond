import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ModelRunSchema,
  ModelVersionSchema,
  type ChatModelRef,
  type ModelProject,
  type ModelRun,
  type OpenPondProfileState,
} from "@openpond/contracts";
import type { BenchmarkComparison, BenchmarkRunSummary } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import {
  commitProfileBenchmarkRef,
  type ProfileBenchmarkGitReceipt,
} from "@openpond/cloud/profile/profile-git";

import { localHarnessWorkspacePaths } from "../harness/local-harness-workspace-service.js";
import { runLocalHarnessRefinerWorker } from "../harness/local-harness-refiner-worker.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import type { SqliteStore } from "../store/store.js";
import type { createTaskEvaluationService } from "./evaluation-service.js";
import {
  BenchmarkEvidenceSnapshot,
  type BenchmarkEvidenceSnapshotManifest,
  type FrozenToolObservation,
  type HarnessRefinerExecutionPlanItem,
} from "./harness-refiner-benchmark-protocol.js";

type Evaluation = ReturnType<typeof createTaskEvaluationService>;
export type EvaluationAttempt = Awaited<ReturnType<Evaluation["execute"]>>;
type StoredTaskAttempt = Awaited<ReturnType<SqliteStore["listTaskAttempts"]>>[number];
type StoredGradeResult = Awaited<ReturnType<SqliteStore["listGradeResultsForTaskset"]>>[number];
type StoredTaskArtifact = Awaited<ReturnType<SqliteStore["listTaskAttemptArtifacts"]>>[number];

export type BenchmarkAttemptEvidence = {
  attempt: StoredTaskAttempt;
  grade: StoredGradeResult;
  artifacts: StoredTaskArtifact[];
  receiptContentHash: string;
};

export type CompletedBenchmarkStage = {
  run: BenchmarkRunSummary;
  attempts: BenchmarkAttemptEvidence[];
};

export type BenchmarkLineage = {
  adaptationEvidenceHash: string;
  refinerInputHash: string;
  refinerOutcomeHash: string;
  validationHash: string;
  applyReceiptHash: string;
  candidateRelease: { id: string; contentHash: string };
  valid: boolean;
};

export type ManagedResultManifest = {
  schemaVersion: "openpond.harnessRefinerBenchmarkResult.v1";
  id: string;
  modelRunId: string;
  benchmarkId: "harness-refiner";
  model: ChatModelRef;
  upstreamModel: {
    providerId: string;
    modelId: string;
    revision: string;
    pricing?: import("./hosted-token-pricing.js").HostedTokenPricing;
  };
  reasoningEffort: string | null;
  tasksetRelease: { id: string; contentHash: string };
  baseline: BenchmarkRunSummary;
  adaptation: BenchmarkRunSummary;
  refiner: { id: string; contentHash: string; outcomeCount: number };
  candidateAdaptation: BenchmarkRunSummary;
  candidate: BenchmarkRunSummary;
  comparison: BenchmarkComparison;
  executionPlan: HarnessRefinerExecutionPlanItem[];
  evidenceSnapshot: ReturnType<BenchmarkEvidenceSnapshot["manifest"]>;
  lineage: BenchmarkLineage;
  publicationPolicy: {
    judgeCalibration: "required_pass";
    diagnosticPasses: 1;
    confirmationPasses: 1;
    uncertainty: "paired_per_case_descriptive";
  };
  harness: {
    baseline: { id: string; contentHash: string };
    candidate: { id: string; contentHash: string };
  };
  createdAt: string;
  contentHash: string;
};

export function completedStage(input: {
  run: BenchmarkRunSummary;
  attempts: EvaluationAttempt[];
}): CompletedBenchmarkStage {
  return {
    run: input.run,
    attempts: input.attempts.map((result) => ({
      attempt: result.attempt,
      grade: result.grade,
      artifacts: result.artifacts,
      receiptContentHash: result.portable.receipt.contentHash,
    })),
  };
}

export async function loadCompletedBenchmarkStage(input: {
  store: SqliteStore;
  modelRunId: string;
  tasksetId: string;
  plan: HarnessRefinerExecutionPlanItem;
}): Promise<CompletedBenchmarkStage> {
  const [runs, attempts, grades] = await Promise.all([
    input.store.listBenchmarkRuns(input.tasksetId),
    input.store.listTaskAttempts(input.tasksetId),
    input.store.listGradeResultsForTaskset(input.tasksetId),
  ]);
  const run = runs.find((candidate) =>
    candidate.metadata.parentModelRunId === input.modelRunId
    && candidate.protocol.split === input.plan.split
    && contentHash(candidate.protocol.taskIds) === contentHash(input.plan.taskIds)
  );
  if (!run) {
    throw new Error(`Completed ${input.plan.stage} benchmark evidence is unavailable.`);
  }
  const taskOrder = new Map(input.plan.taskIds.map((taskId, index) => [taskId, index]));
  const selected = attempts
    .filter((attempt) =>
      attempt.metadata.parentModelRunId === input.modelRunId
      && taskOrder.has(attempt.taskId)
    )
    .sort((left, right) =>
      (taskOrder.get(left.taskId) ?? 0) - (taskOrder.get(right.taskId) ?? 0)
      || left.seed - right.seed
      || left.attempt - right.attempt
    );
  if (selected.length !== input.plan.attemptCount) {
    throw new Error(
      `Completed ${input.plan.stage} evidence has ${selected.length}/${input.plan.attemptCount} attempts.`,
    );
  }
  const gradesByAttempt = new Map(grades.map((grade) => [grade.attemptId, grade]));
  const evidence = await Promise.all(selected.map(async (attempt) => {
    const grade = gradesByAttempt.get(attempt.id);
    if (!grade) throw new Error(`Attempt ${attempt.id} has no durable grade.`);
    return {
      attempt,
      grade,
      artifacts: await input.store.listTaskAttemptArtifacts({ attemptId: attempt.id }),
      receiptContentHash: portableReceiptContentHash(attempt),
    };
  }));
  return { run, attempts: evidence };
}

function portableReceiptContentHash(attempt: StoredTaskAttempt): string {
  const receipt = objectRecord(attempt.metadata.portableAttemptReceipt);
  const hash = receipt?.contentHash;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Attempt ${attempt.id} has no durable portable receipt.`);
  }
  return hash;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function releasedHarness(record: {
  agentSnapshot: import("@openpond/harness").AgentSnapshot;
  harnessRelease: import("@openpond/harness").HarnessRelease;
}, instructionContext?: string) {
  return {
    agentSnapshot: record.agentSnapshot,
    harnessRelease: record.harnessRelease,
    instructionContext,
  };
}

export function stringMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function taskPrompt(task: { input: Record<string, unknown> }): string {
  if (typeof task.input.prompt === "string" && task.input.prompt.trim()) {
    return task.input.prompt;
  }
  const messages = Array.isArray(task.input.messages) ? task.input.messages : [];
  return messages
    .flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const content = (message as Record<string, unknown>).content;
      return typeof content === "string" && content.trim() ? [content] : [];
    })
    .join("\n\n");
}

export async function requireModelProject(
  store: SqliteStore,
  modelId: string,
  profileId: string,
) {
  const project = await store.getModelProject(modelId);
  if (!project || project.profileId !== profileId) {
    throw new Error("A Model in the active Profile is required.");
  }
  return project;
}

export async function updateProgress(
  store: SqliteStore,
  modelRunId: string,
  progress: Omit<
    NonNullable<ModelRun["evaluationProgress"]>,
    "accounting" | "evidenceSnapshot"
  > & {
    accounting?: EvaluationAccounting;
    evidenceSnapshot?: NonNullable<ModelRun["evaluationProgress"]>["evidenceSnapshot"];
  },
) {
  const run = await store.getModelRun(modelRunId);
  if (!run || run.kind !== "evaluation") {
    throw new Error(`Evaluation Model Run ${modelRunId} is unavailable.`);
  }
  if (run.status !== "running") return run;
  return store.saveModelRun(ModelRunSchema.parse({
    ...run,
    evaluationProgress: {
      ...run.evaluationProgress,
      ...progress,
    },
    updatedAt: new Date().toISOString(),
  }));
}

type EvaluationAccounting = NonNullable<
  NonNullable<ModelRun["evaluationProgress"]>["accounting"]
>;

export function emptyEvaluationAccounting(): EvaluationAccounting {
  return {
    usage: {
      baseline: emptyUsageCategory(),
      adaptation: emptyUsageCategory(),
      candidateAdaptation: emptyUsageCategory(),
      candidate: emptyUsageCategory(),
      refiner: emptyUsageCategory(),
      grader: emptyUsageCategory(),
    },
    observedSpendUsd: 0,
    attempts: [],
  };
}

export async function checkpointAttempt(
  store: SqliteStore,
  modelRunId: string,
  input: {
    stage: HarnessRefinerExecutionPlanItem["stage"];
    completedAttempts: number;
    totalAttempts: number;
    result: EvaluationAttempt;
    grader: EvaluationUsageCategory;
    observedSpendUsd: number;
  },
) {
  const current = await store.getModelRun(modelRunId);
  if (!current || current.status !== "running") return current;
  const accounting = structuredClone(
    current.evaluationProgress?.accounting ?? emptyEvaluationAccounting(),
  );
  const usage = emptyUsageCategory();
  const rawUsage = input.result.attempt.metadata.usage;
  for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
    addUsage(usage, item);
  }
  if (input.result.attempt.costUsd !== null) {
    usage.costUsd = input.result.attempt.costUsd;
  }
  const usageKey = input.stage === "candidate_adaptation"
    ? "candidateAdaptation"
    : input.stage;
  mergeUsage(accounting.usage[usageKey], usage);
  mergeUsage(accounting.usage.grader, input.grader);
  accounting.observedSpendUsd = input.observedSpendUsd;
  const attempt = modelEvaluationAttempts(input.stage, [input.result])[0]!;
  accounting.attempts = [
    ...accounting.attempts.filter((item) => item.attemptId !== attempt.attemptId),
    attempt,
  ];
  return updateProgress(store, modelRunId, {
    stage: input.stage,
    completedAttempts: input.completedAttempts,
    totalAttempts: input.totalAttempts,
    accounting,
  });
}

export async function checkpointRefinerUsage(
  store: SqliteStore,
  modelRunId: string,
  usage: EvaluationUsageCategory,
  observedSpendUsd: number,
) {
  const current = await store.getModelRun(modelRunId);
  if (!current || current.status !== "running" || !current.evaluationProgress) {
    return current;
  }
  const accounting = structuredClone(
    current.evaluationProgress.accounting ?? emptyEvaluationAccounting(),
  );
  mergeUsage(accounting.usage.refiner, usage);
  accounting.observedSpendUsd = observedSpendUsd;
  return updateProgress(store, modelRunId, {
    stage: current.evaluationProgress.stage,
    completedAttempts: current.evaluationProgress.completedAttempts,
    totalAttempts: current.evaluationProgress.totalAttempts,
    accounting,
  });
}

export async function checkpointEvidenceSnapshot(
  store: SqliteStore,
  storeDir: string,
  modelRunId: string,
  snapshot: BenchmarkEvidenceSnapshotManifest,
) {
  const directory = path.join(
    storeDir,
    "training",
    "harness-refiner-benchmarks",
    modelRunId,
  );
  await fs.mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, "evidence-snapshot.json");
  await fs.writeFile(artifactPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const run = await store.getModelRun(modelRunId);
  if (!run || run.status !== "running" || !run.evaluationProgress) return run;
  return store.saveModelRun(ModelRunSchema.parse({
    ...run,
    evaluationProgress: {
      ...run.evaluationProgress,
      evidenceSnapshot: {
        id: snapshot.id,
        contentHash: snapshot.contentHash,
        artifactPath,
      },
    },
    updatedAt: new Date().toISOString(),
  }));
}

export async function loadOrReconstructEvidenceSnapshot(input: {
  store: SqliteStore;
  storeDir: string;
  modelRun: ModelRun;
  attempts: Array<{
    result: BenchmarkAttemptEvidence;
    cohort: "adaptation" | "held_out";
  }>;
}): Promise<BenchmarkEvidenceSnapshot> {
  const ref = input.modelRun.evaluationProgress?.evidenceSnapshot;
  if (ref) {
    const manifest = parseEvidenceSnapshotManifest(
      JSON.parse(await fs.readFile(ref.artifactPath, "utf8")),
    );
    if (manifest.id !== ref.id || manifest.contentHash !== ref.contentHash) {
      throw new Error("Durable benchmark evidence snapshot does not match its admitted ref.");
    }
    return new BenchmarkEvidenceSnapshot(manifest.observations);
  }
  const observations = await reconstructFrozenToolObservations(
    input.store,
    input.attempts,
  );
  const snapshot = new BenchmarkEvidenceSnapshot(observations);
  await checkpointEvidenceSnapshot(
    input.store,
    input.storeDir,
    input.modelRun.id,
    snapshot.manifest(),
  );
  return snapshot;
}

function parseEvidenceSnapshotManifest(value: unknown): BenchmarkEvidenceSnapshotManifest {
  const record = objectRecord(value);
  if (
    record?.schemaVersion !== "openpond.benchmarkEvidenceSnapshot.v1"
    || typeof record.id !== "string"
    || typeof record.contentHash !== "string"
    || !Array.isArray(record.observations)
  ) {
    throw new Error("Durable benchmark evidence snapshot is malformed.");
  }
  const observations = record.observations.map((item) => {
    const observation = objectRecord(item);
    const result = objectRecord(observation?.result);
    if (
      (observation?.cohort !== "adaptation" && observation?.cohort !== "held_out")
      || typeof observation.taskId !== "string"
      || (observation.toolName !== "web_search" && observation.toolName !== "web_fetch")
      || typeof observation.argumentsHash !== "string"
      || !Number.isInteger(observation.ordinal)
      || (observation.ordinal as number) < 0
      || !result
      || typeof result.toolCallId !== "string"
      || typeof result.name !== "string"
      || typeof result.ok !== "boolean"
      || typeof result.contentText !== "string"
    ) {
      throw new Error("Durable benchmark evidence snapshot contains a malformed observation.");
    }
    return observation as FrozenToolObservation;
  });
  const core = {
    schemaVersion: "openpond.benchmarkEvidenceSnapshot.v1" as const,
    id: record.id,
    observations,
  };
  if (contentHash(core) !== record.contentHash) {
    throw new Error("Durable benchmark evidence snapshot failed content-hash validation.");
  }
  return { ...core, contentHash: record.contentHash };
}

async function reconstructFrozenToolObservations(
  store: SqliteStore,
  attempts: Array<{
    result: BenchmarkAttemptEvidence;
    cohort: "adaptation" | "held_out";
  }>,
): Promise<FrozenToolObservation[]> {
  const observations: FrozenToolObservation[] = [];
  for (const { result, cohort } of attempts) {
    const sessionId = stringMetadata(result.attempt.metadata, "sessionId");
    const turnId = stringMetadata(result.attempt.metadata, "turnId");
    if (!sessionId || !turnId) continue;
    const events = (await store.runtimeEventsForSession(sessionId, {
      names: ["tool.started", "tool.completed"],
      limit: 100_000,
    })).filter((entry) => entry.turnId === turnId);
    const started = new Map<string, {
      toolName: "web_search" | "web_fetch";
      args: Record<string, unknown>;
      ordinal: number;
    }>();
    const ordinals = new Map<string, number>();
    for (const entry of events) {
      const data = objectRecord(entry.data);
      const callId = typeof data?.toolCallId === "string" ? data.toolCallId : null;
      const toolName = entry.action === "web_search" || entry.action === "web_fetch"
        ? entry.action
        : null;
      if (!callId || !toolName) continue;
      if (entry.name === "tool.started") {
        const ordinal = ordinals.get(toolName) ?? 0;
        ordinals.set(toolName, ordinal + 1);
        started.set(callId, {
          toolName,
          args: objectRecord(entry.args) ?? {},
          ordinal,
        });
        continue;
      }
      const start = started.get(callId);
      const payload = objectRecord(data?.result);
      if (!start || !payload) continue;
      const ok = typeof payload.ok === "boolean"
        ? payload.ok
        : entry.status === "completed";
      const contentText = typeof payload.output === "string"
        ? payload.output
        : typeof entry.output === "string"
          ? entry.output
          : "";
      const nativeData = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "ok" && key !== "output"),
      );
      observations.push({
        cohort,
        taskId: result.attempt.taskId,
        toolName: start.toolName,
        argumentsHash: contentHash(start.args),
        ordinal: start.ordinal,
        result: {
          toolCallId: callId,
          name: start.toolName,
          ok,
          contentText,
          ...(Object.keys(nativeData).length ? { data: nativeData } : {}),
        },
      });
    }
  }
  return observations;
}

export function createResultManifest(
  input: Omit<ManagedResultManifest, "schemaVersion" | "id" | "benchmarkId" | "tasksetRelease" | "harness" | "publicationPolicy" | "contentHash">,
): ManagedResultManifest {
  const core = {
    schemaVersion: "openpond.harnessRefinerBenchmarkResult.v1" as const,
    id: `benchmark-result-${input.modelRunId}`,
    modelRunId: input.modelRunId,
    benchmarkId: "harness-refiner" as const,
    model: input.model,
    upstreamModel: input.upstreamModel,
    reasoningEffort: input.reasoningEffort,
    tasksetRelease: input.baseline.tasksetRelease,
    baseline: input.baseline,
    adaptation: input.adaptation,
    refiner: input.refiner,
    candidateAdaptation: input.candidateAdaptation,
    candidate: input.candidate,
    comparison: input.comparison,
    executionPlan: input.executionPlan,
    evidenceSnapshot: input.evidenceSnapshot,
    lineage: input.lineage,
    publicationPolicy: {
      judgeCalibration: "required_pass" as const,
      diagnosticPasses: 1 as const,
      confirmationPasses: 1 as const,
      uncertainty: "paired_per_case_descriptive" as const,
    },
    harness: {
      baseline: input.baseline.harnessRelease,
      candidate: input.candidate.harnessRelease,
    },
    createdAt: input.createdAt,
  };
  return { ...core, contentHash: contentHash(core) };
}

export async function writeManagedResult(
  storeDir: string,
  modelRunId: string,
  manifest: ManagedResultManifest,
) {
  const root = path.join(storeDir, "training", "model-runs", modelRunId, "benchmark");
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${manifest.contentHash}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path.relative(storeDir, filePath).replaceAll(path.sep, "/");
}

export async function preserveProfileResult(input: {
  profile: OpenPondProfileState;
  modelRunId: string;
  workspaceId: string;
  storeDir: string;
  manifest: ManagedResultManifest;
}): Promise<ProfileBenchmarkGitReceipt | null> {
  if (
    input.profile.mode !== "local"
    || !input.profile.repoPath
    || !input.profile.git?.head
  ) return null;
  const sourceRoot = localHarnessWorkspacePaths(
    input.storeDir,
    input.workspaceId,
  ).source;
  const sourceFiles = await listFiles(sourceRoot);
  const prefix = `benchmarks/harness-refiner/runs/${input.modelRunId}`;
  return commitProfileBenchmarkRef({
    repoPath: input.profile.repoPath,
    runId: input.modelRunId,
    baseCommit: input.profile.git.head,
    message: `Preserve Harness Refiner benchmark ${input.modelRunId}`,
    files: [
      {
        path: `${prefix}/result.json`,
        contents: `${JSON.stringify(input.manifest, null, 2)}\n`,
      },
      ...await Promise.all(sourceFiles.map(async (relativePath) => ({
        path: `${prefix}/candidate-harness/${relativePath}`,
        contents: await fs.readFile(path.join(sourceRoot, ...relativePath.split("/"))),
      }))),
    ],
  });
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

export async function ensureBaseVersion(input: {
  store: SqliteStore;
  project: ModelProject;
  modelRun: ModelRun;
  model: ChatModelRef;
  baseline: EvaluationAttempt | BenchmarkAttemptEvidence;
}) {
  const existing = await input.store.getModelVersion(input.modelRun.modelVersionId);
  if (existing) return existing;
  if (!("portable" in input.baseline)) {
    throw new Error("A portable baseline attempt is required to create the base Model Version.");
  }
  const runManifest = input.baseline.portable.runManifest;
  const tasksetRelease = input.baseline.portable.tasksetRelease;
  const graph = {
    resolvedBundleHash: contentHash({
      tasksetRelease: tasksetRelease.contentHash,
      runManifest: runManifest.contentHash,
    }),
    profileRelease: {
      id: `profile-release-${input.modelRun.profileId}`,
      revision: 1,
      contentHash: contentHash({ profileId: input.modelRun.profileId }),
    },
    harnessRelease: runManifest.harnessRelease,
    agentRelease: {
      id: input.baseline.portable.agentSnapshot.id,
      contentHash: input.baseline.portable.agentSnapshot.contentHash,
    },
    grader: {
      id: `grader-${tasksetRelease.id}`,
      contentHash: contentHash(tasksetRelease.graders),
    },
  };
  const core = {
    schemaVersion: "openpond.modelVersion.v1" as const,
    id: input.modelRun.modelVersionId,
    modelId: input.project.id,
    profileId: input.project.profileId,
    version: 0,
    kind: "base_reference" as const,
    status: "available" as const,
    baseModel: {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: `${input.model.providerId}/${input.model.modelId}`,
      revision: runManifest.model.revision,
      tokenizerRevision: runManifest.model.tokenizerRevision,
      chatTemplateHash: runManifest.model.chatTemplateHash,
      modelAssetId: null,
      source: "managed" as const,
    },
    taskset: input.modelRun.taskset,
    releaseGraph: graph,
    artifactLineageId: null,
    adapterStatus: "not_trained" as const,
    createdAt: input.modelRun.startedAt,
  };
  return input.store.saveModelVersion(ModelVersionSchema.parse({
    ...core,
    contentHash: contentHash(core),
  }));
}

function modelEvaluationAttempts(
  phase: "baseline" | "adaptation" | "candidate_adaptation" | "candidate",
  results: Array<Pick<BenchmarkAttemptEvidence, "attempt" | "grade">>,
) {
  return results.map((result) => {
    const usage = emptyUsageCategory();
    const rawUsage = result.attempt.metadata.usage;
    for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
      addUsage(usage, item);
    }
    return {
      phase,
      taskId: result.attempt.taskId,
      attemptId: result.attempt.id,
      sessionId: stringMetadata(result.attempt.metadata, "sessionId"),
      turnId: stringMetadata(result.attempt.metadata, "turnId"),
      passed: result.grade.passed,
      score: result.grade.score,
      failureClass: result.grade.failureClass,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      latencyMs: result.attempt.latencyMs,
      costUsd: result.attempt.costUsd,
      startedAt: result.attempt.startedAt,
    };
  });
}

export function attemptUsageSummary(rawUsage: unknown) {
  const usage = emptyUsageCategory();
  for (const item of Array.isArray(rawUsage) ? rawUsage : [rawUsage]) {
    addUsage(usage, item);
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

export function attemptToolFailureCount(
  result: Pick<BenchmarkAttemptEvidence, "attempt">,
): number {
  const value = result.attempt.output.toolFailureCount;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

export async function benchmarkToolFailureEvidence(input: {
  attemptId: string;
  artifacts: Array<Pick<StoredTaskArtifact, "kind" | "path" | "sha256">>;
  expectedCount: number;
}): Promise<{
  failures: Array<{
    toolName: string;
    turn: number | null;
    detail: string;
    recoveredLater: boolean;
  }>;
  omittedCount: number;
}> {
  if (input.expectedCount === 0) return { failures: [], omittedCount: 0 };
  const trace = input.artifacts.find((artifact) => artifact.kind === "runtime_trace");
  if (!trace) {
    throw new Error(`Attempt ${input.attemptId} has tool failures but no runtime trace.`);
  }
  const bytes = await fs.readFile(trace.path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== trace.sha256) {
    throw new Error(`Attempt ${input.attemptId} runtime trace failed hash validation.`);
  }
  const parsed = objectRecord(JSON.parse(bytes.toString("utf8")));
  const steps = Array.isArray(parsed?.steps)
    ? parsed.steps.map((step) => objectRecord(step)).filter(Boolean)
    : [];
  const failures = steps.flatMap((step, index) => {
    if (step?.kind !== "tool" || step.ok !== false) return [];
    const toolName = typeof step.name === "string" && step.name.trim()
      ? step.name.trim()
      : "unknown_tool";
    const recoveredLater = steps.slice(index + 1).some(
      (candidate) => candidate?.kind === "tool"
        && candidate.name === toolName
        && candidate.ok === true,
    );
    return [{
      toolName,
      turn: typeof step.turn === "number" && Number.isInteger(step.turn)
        ? step.turn
        : null,
      detail: typeof step.output === "string"
        ? step.output.slice(0, 1_000)
        : "Tool failed without textual output.",
      recoveredLater,
    }];
  });
  if (failures.length !== input.expectedCount) {
    throw new Error(
      `Attempt ${input.attemptId} tool-failure count drifted between its receipt and runtime trace.`,
    );
  }
  const visible = failures.slice(0, 20);
  return {
    failures: visible,
    omittedCount: failures.length - visible.length,
  };
}

type EvaluationUsageCategory = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export function emptyUsageCategory(): EvaluationUsageCategory {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null };
}

export function addUsage(
  category: EvaluationUsageCategory,
  usage: unknown,
  costUsd?: number,
) {
  const normalized = normalizeModelUsageTokens(usage);
  category.inputTokens += normalized.promptTokens ?? 0;
  category.outputTokens += normalized.completionTokens ?? 0;
  category.totalTokens += normalized.totalTokens ?? 0;
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) {
    category.costUsd = (category.costUsd ?? 0) + costUsd;
  }
}

function mergeUsage(
  target: EvaluationUsageCategory,
  source: EvaluationUsageCategory,
) {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  if (source.costUsd !== null) {
    target.costUsd = (target.costUsd ?? 0) + source.costUsd;
  }
}

export function requirePlanStage(
  plan: HarnessRefinerExecutionPlanItem[],
  stage: HarnessRefinerExecutionPlanItem["stage"],
) {
  const item = plan.find((candidate) => candidate.stage === stage);
  if (!item) throw new Error(`Harness Refiner plan is missing ${stage}.`);
  return item;
}

export function frozenToolEvidence(
  snapshot: BenchmarkEvidenceSnapshot,
  mode: "record" | "replay",
  cohort: "adaptation" | "held_out",
) {
  return {
    execute: (input: {
      taskId: string;
      toolName: string;
      args: Record<string, unknown>;
      execute: () => Promise<import("../openpond/native-tool-calls.js").NativeModelToolResult>;
    }) => snapshot.execute({ ...input, mode, cohort }),
  };
}

export async function benchmarkLineage(input: {
  store: SqliteStore;
  workspaceId: string;
  adaptationAttempts: BenchmarkAttemptEvidence[];
  refinerResults: Array<Awaited<ReturnType<typeof runLocalHarnessRefinerWorker>>>;
  candidateRelease: { id: string; contentHash: string };
  refinerInputHash: string;
}): Promise<BenchmarkLineage> {
  const [outcomes, validations, applyReceipts] = await Promise.all([
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "refiner_outcome",
      1_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "targeted_validation",
      10_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "apply_receipt",
      1_000,
    ),
  ]);
  const adaptationEvidenceHash = contentHash(input.adaptationAttempts.map((result) => ({
    attempt: result.attempt.id,
    receipt: result.receiptContentHash,
    grade: contentHash(result.grade),
  })));
  const proposalResults = input.refinerResults.filter((result) => result.proposal);
  const requiredValidationsPassed = proposalResults.every((result) =>
    result.proposal!.validationPlan
      .filter((plan) => plan.required)
      .every((plan) => result.validations.some(
        (validation) => validation.validationId === plan.id && validation.status === "passed",
      ))
  );
  const proposalHashes = new Set(
    proposalResults.map((result) => result.proposal!.contentHash),
  );
  const appliedProposalHashes = new Set(applyReceipts.flatMap((artifact) => {
    const proposal = "proposal" in artifact ? artifact.proposal : null;
    return proposal && typeof proposal === "object" && "contentHash" in proposal
      ? [String(proposal.contentHash)]
      : [];
  }));
  const everyProposalHasReceipt = [...proposalHashes].every((hash) =>
    appliedProposalHashes.has(hash)
  );
  return {
    adaptationEvidenceHash,
    refinerInputHash: input.refinerInputHash,
    refinerOutcomeHash: contentHash(outcomes),
    validationHash: contentHash(validations),
    applyReceiptHash: contentHash(applyReceipts),
    candidateRelease: input.candidateRelease,
    valid:
      outcomes.length === input.refinerResults.length
      && requiredValidationsPassed
      && everyProposalHasReceipt,
  };
}

export function comparisonInvalidReasons(input: {
  baseline: BenchmarkRunSummary;
  adaptation: BenchmarkRunSummary;
  candidateAdaptation: BenchmarkRunSummary;
  candidate: BenchmarkRunSummary;
  harnessChanged: boolean;
  lineageValid: boolean;
  infrastructureValid: boolean;
}): string[] {
  const reasons: string[] = [];
  for (const [label, run] of [
    ["held-out baseline", input.baseline],
    ["adaptation baseline", input.adaptation],
    ["candidate adaptation replay", input.candidateAdaptation],
    ["held-out candidate", input.candidate],
  ] as const) {
    if (run.terminalCount !== run.attemptCount) {
      reasons.push(`${label} did not terminalize all admitted attempts.`);
    }
  }
  if (!input.infrastructureValid) {
    reasons.push("At least one attempt has infrastructure-invalid outcome evidence.");
  }
  if (!input.harnessChanged) reasons.push("The candidate Harness is unchanged.");
  if (!input.lineageValid) reasons.push("Candidate Harness lineage is incomplete.");
  if (input.candidateAdaptation.passedCount !== input.candidateAdaptation.attemptCount) {
    reasons.push("Candidate adaptation replay did not pass every case.");
  }
  if (input.candidate.passedCount !== input.candidate.attemptCount) {
    reasons.push("Candidate held-out quality did not pass every case.");
  }
  return reasons;
}

export function classifyComparison(input: {
  comparison: BenchmarkComparison;
  baseline: BenchmarkRunSummary;
  adaptation: BenchmarkRunSummary;
  candidate: BenchmarkRunSummary;
  candidateAdaptation: BenchmarkRunSummary;
  harnessChanged: boolean;
  lineageValid: boolean;
  infrastructureValid: boolean;
}): "improved" | "no_improvement" | "regressed" | "inconclusive" | "infrastructure_failure" {
  if (
    !input.infrastructureValid
    ||
    input.baseline.terminalCount !== input.baseline.attemptCount
    || input.adaptation.terminalCount !== input.adaptation.attemptCount
    || input.candidate.terminalCount !== input.candidate.attemptCount
    || input.candidateAdaptation.terminalCount !== input.candidateAdaptation.attemptCount
  ) return "infrastructure_failure";
  if (!input.harnessChanged || !input.lineageValid) return "inconclusive";
  if (
    !input.comparison.qualityPassed
    || input.candidate.passedCount !== input.candidate.attemptCount
    || input.candidateAdaptation.passedCount !== input.candidateAdaptation.attemptCount
  ) return "regressed";
  return input.comparison.improved ? "improved" : "no_improvement";
}

export function modelVersionId(modelId: string) {
  return `model_version_${contentHash({ modelId, version: 0 }).slice(0, 24)}`;
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 5_000) || "Harness Refiner benchmark failed.";
}
