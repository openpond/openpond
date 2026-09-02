import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ModelComparisonBenchmarkReceiptSchema,
  ModelRunSchema,
  type ChatModelRef,
  type ModelComparisonEntryStatus,
  type ModelComparisonSeries,
  type ModelComparisonSeriesEntry,
  type ModelRun,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import { hostedApiAuthHeaders, resolveManagedAdapterUserAccess } from "../openpond/hosted-api-access.js";
import type { SqliteStore } from "../store/store.js";
import type { createModelComparisonSeriesService } from "./model-comparison-series-service.js";
import { executeTau3RetailManagedRl } from "./tau3-retail-managed-rl-adapter.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-runner.js";
import { NativeToolCallAccumulator } from "../openpond/native-tool-calls.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import {
  createCodexTasksetPolicyRuntime,
  type CodexTasksetPolicyRuntime,
} from "./codex-taskset-policy-runtime.js";

type ComparisonSeriesService = ReturnType<typeof createModelComparisonSeriesService>;
type Access = { apiBaseUrl: string; token: string; teamId: string };
type CohortRole = "current" | "development" | "retained" | "prior_disclosed" | "frozen_final";

type StartInput = {
  entryId: string;
  cohortRole: CohortRole;
  seeds?: number[];
  repetitions?: number;
  maximumSpendUsd?: number;
  maxGpuSeconds?: number;
};

type ReferenceStartInput = {
  seriesId: string;
  cohortRole: CohortRole;
  targetKind: "base_model" | "external_reference";
  label: string;
  model: ChatModelRef;
  seeds?: number[];
  repetitions?: number;
  maximumSpendUsd?: number;
};

type SignedQuote = {
  quote: Record<string, unknown> & { hourlyUsd?: string; diskHourlyUsd?: string; quotedAt?: string };
  quoteSignature: string;
  imageVerified?: boolean;
};

type SoakStatus = {
  job: { id: string; state: string; version: number; accruedSpendUsd?: string };
  source: { policyVersion: number; adapterSha256: string };
  serving: { state: string; policyVersion: number | null; adapterSha256: string | null };
};

const TERMINAL_SOAK_STATES = new Set(["completed", "cancelled", "failed", "budget_exhausted"]);

export function createModelComparisonEvaluationService(deps: {
  store: SqliteStore;
  storeDir: string;
  comparisonSeries: ComparisonSeriesService;
  resolveAccess?: (teamId?: string) => Promise<Access>;
  modelStream?: TasksetWorkModelStream;
  fetch?: typeof fetch;
}) {
  const fetchImpl = deps.fetch ?? fetch;
  const resolveAccess = deps.resolveAccess ?? ((teamId) => resolveManagedAdapterUserAccess({ teamId }));
  const active = new Map<string, Promise<ModelRun>>();

  async function start(input: StartInput): Promise<ModelRun> {
    const entry = await requireEntry(deps.store, input.entryId);
    if (!entry.modelVersionId) throw new Error("Comparison evaluation requires a trained Model Version.");
    const series = await requireSeries(deps.store, entry.seriesId);
    const tasksetRef = cohortTaskset(series, entry, input.cohortRole);
    const taskset = await deps.store.getTasksetRevision(tasksetRef.id, tasksetRef.revision, tasksetRef.contentHash)
      ?? await deps.store.getTaskset(tasksetRef.id);
    if (!taskset || taskset.revision !== tasksetRef.revision || taskset.contentHash !== tasksetRef.contentHash) {
      throw new Error("The exact Comparison evaluation Taskset is unavailable.");
    }
    const project = await deps.store.getModelProject(entry.modelProjectId);
    if (!project?.hosted?.teamId) throw new Error("Comparison evaluation requires a hosted Model Project workspace.");
    const seeds = [...new Set(input.seeds ?? [1701])];
    const repetitions = input.repetitions ?? 1;
    const totalAttempts = taskset.tasks.length * seeds.length * repetitions;
    if (!totalAttempts) throw new Error("Comparison evaluation Taskset has no tasks.");
    const maximumSpendUsd = input.maximumSpendUsd ?? 6;
    const maxGpuSeconds = input.maxGpuSeconds ?? 7_200;
    const id = `model_evaluation_${randomUUID()}`;
    const now = new Date().toISOString();
    const run = await deps.store.saveModelRun(ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id,
      modelId: entry.modelProjectId,
      modelVersionId: entry.modelVersionId,
      profileId: entry.profileId,
      kind: "evaluation",
      status: "prepared",
      method: null,
      destinationId: null,
      taskset: tasksetRef,
      comparisonSeriesEntry: entryRef(entry),
      harnessRelease: project.trainingSetup.harnessRelease,
      quote: { maximumSpendUsd, hourlyCostUsd: null },
      evaluation: {
        benchmarkId: "model-comparison",
        target: { kind: "model_version", label: entry.label, modelVersionId: entry.modelVersionId, model: null },
        grader: series.grader,
        judge: null,
        seeds,
        repetitions,
        maximumSpendUsd,
        attemptPlan: [{ stage: "comparison", split: input.cohortRole, taskIds: taskset.tasks.map((task) => task.id), attemptCount: totalAttempts }],
      },
      evaluationProgress: { stage: "comparison", completedAttempts: 0, totalAttempts, accounting: null, evidenceSnapshot: null },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    }));
    const execution = execute({ run, entry, series, taskset, cohortRole: input.cohortRole, maximumSpendUsd, maxGpuSeconds, teamId: project.hosted.teamId, referenceModel: null });
    active.set(id, execution);
    void execution.finally(() => active.delete(id));
    return run;
  }

  async function startReference(input: ReferenceStartInput): Promise<ModelRun> {
    if (input.model.providerId !== "codex" && !deps.modelStream) {
      throw new Error("External Comparison evaluation is not configured.");
    }
    const series = await requireSeries(deps.store, input.seriesId);
    const tasksetRef = cohortTaskset(series, null, input.cohortRole);
    const taskset = await deps.store.getTasksetRevision(tasksetRef.id, tasksetRef.revision, tasksetRef.contentHash)
      ?? await deps.store.getTaskset(tasksetRef.id);
    if (!taskset || taskset.revision !== tasksetRef.revision || taskset.contentHash !== tasksetRef.contentHash) throw new Error("The exact Comparison evaluation Taskset is unavailable.");
    const project = await deps.store.getModelProject(series.modelProjectId);
    if (!project) throw new Error("The Comparison Model Project is unavailable.");
    const seeds = [...new Set(input.seeds ?? [1701])];
    const repetitions = input.repetitions ?? 1;
    const totalAttempts = taskset.tasks.length * seeds.length * repetitions;
    const maximumSpendUsd = input.maximumSpendUsd ?? 20;
    const id = `model_evaluation_${randomUUID()}`;
    const now = new Date().toISOString();
    const run = await deps.store.saveModelRun(ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1", id, modelId: series.modelProjectId, modelVersionId: null,
      profileId: series.profileId, kind: "evaluation", status: "prepared", method: null, destinationId: null,
      taskset: tasksetRef, comparisonSeriesEntry: null, harnessRelease: project.trainingSetup.harnessRelease,
      quote: { maximumSpendUsd, hourlyCostUsd: null },
      evaluation: { benchmarkId: "model-comparison", target: { kind: input.targetKind, label: input.label, modelVersionId: null, model: input.model }, grader: series.grader, judge: null, seeds, repetitions, maximumSpendUsd, attemptPlan: [{ stage: "comparison", split: input.cohortRole, taskIds: taskset.tasks.map((task) => task.id), attemptCount: totalAttempts }] },
      evaluationProgress: { stage: "comparison", completedAttempts: 0, totalAttempts, accounting: null, evidenceSnapshot: null },
      reward: null, receipt: null, adapterArtifactLineageId: null, failure: null, startedAt: now, completedAt: null, updatedAt: now,
    }));
    const execution = execute({ run, entry: null, series, taskset, cohortRole: input.cohortRole, maximumSpendUsd, maxGpuSeconds: 0, teamId: null, referenceModel: input.model });
    active.set(id, execution);
    void execution.finally(() => active.delete(id));
    return run;
  }

  async function execute(input: {
    run: ModelRun;
    entry: ModelComparisonSeriesEntry | null;
    series: ModelComparisonSeries;
    taskset: Taskset;
    cohortRole: CohortRole;
    maximumSpendUsd: number;
    maxGpuSeconds: number;
    teamId: string | null;
    referenceModel: ChatModelRef | null;
  }): Promise<ModelRun> {
    const evaluation = input.run.evaluation;
    if (!evaluation || evaluation.benchmarkId !== "model-comparison") {
      throw new Error("Comparison evaluation configuration is invalid.");
    }
    const runningAt = new Date().toISOString();
    await deps.store.saveModelRun(ModelRunSchema.parse({ ...input.run, status: "running", updatedAt: runningAt }));
    let soak: SoakStatus | null = null;
    let access: Access | null = null;
    const codexPolicy = input.referenceModel?.providerId === "codex"
      ? createCodexTasksetPolicyRuntime({
          modelId: input.referenceModel.modelId,
          runId: input.run.id,
          cwd: process.cwd(),
          reasoningEffort: "xhigh",
        })
      : null;
    try {
      if (input.entry) {
        access = await resolveAccess(input.teamId!);
        const checkpointId = await checkpointForEntry(deps.store, input.entry);
        const quote = await stableQuote(access, fetchImpl);
        assertQuoteFitsCap(quote, input.maximumSpendUsd, input.maxGpuSeconds);
        soak = await createSoak({ access, fetchImpl, checkpointId, requestCount: Math.max(16, input.taskset.tasks.length), maximumSpendUsd: input.maximumSpendUsd, maxGpuSeconds: input.maxGpuSeconds, runId: input.run.id, quote });
        soak = await waitForSoak(access, fetchImpl, soak.job.id, input.maxGpuSeconds);
      }
      const evidenceAttempts: Array<Record<string, unknown>> = [];
      const attempts: Array<{
        taskId: string;
        seed: number;
        repetition: number;
        status: "succeeded" | "failed";
        deterministicScore: number | null;
        passed: boolean | null;
        judgeScore: null;
        judgePreference: null;
        transcriptHash: string | null;
        traceHash: string | null;
        failureClass: "policy" | "environment" | "grader" | "budget" | "harness" | "timeout" | "unknown" | null;
      }> = [];
      const policyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null as number | null };
      let policyUsageObserved = false;
      let completed = 0;
      for (const seed of evaluation.seeds) {
        for (let repetition = 0; repetition < evaluation.repetitions; repetition += 1) {
          for (const task of input.taskset.tasks) {
            const deliveryId = contentHash({ runId: input.run.id, taskId: task.id, seed, repetition });
            try {
              const capability = input.entry
                ? await requestJson<{ token: string; source: { policyVersion: number } }>(access!, fetchImpl, `/v1/managed-rl/serving-soaks/${encodeURIComponent(soak!.job.id)}/deliveries`, { method: "POST", body: JSON.stringify({ deliveryId }) })
                : { token: "external-reference", source: { policyVersion: 0 } };
              const result = await executeTau3RetailManagedRl({
                claim: {
                  schemaVersion: "openpond.managedRlLocalRolloutClaim.v1",
                  executionKind: "evaluation",
                  executionId: `${input.run.id}:${task.id}:${seed}:${repetition}`,
                  jobId: soak?.job.id ?? input.run.id,
                  groupId: null,
                  rolloutId: null,
                  deliveryId,
                  policyVersion: capability.source.policyVersion,
                  task: { id: task.id, expectedText: null },
                  taskset: input.run.taskset,
                  harnessRelease: input.run.harnessRelease ?? input.series.grader,
                  reward: { kind: "local_harness_receipt_v1", environmentId: input.taskset.environment.entrypoint },
                  environmentSha256: contentHash(input.taskset.environment),
                  request: { seed },
                  policy: { path: "/v1/managed-rl/policy/chat/completions", token: capability.token },
                },
                taskset: input.taskset,
                task,
                harnessRoot: process.cwd(),
                storeDir: deps.storeDir,
                executorId: `comparison-evaluator:${input.run.id}`,
                signal: AbortSignal.timeout(12 * 60_000),
                policyRequest: input.entry
                  ? (request, signal) => policyRequest(access!, fetchImpl, capability.token, request, signal)
                  : codexPolicy
                    ? (request, signal) => codexPolicyRequest(codexPolicy, request, signal)
                    : (request, signal) => externalPolicyRequest(deps.modelStream!, input.referenceModel!, input.run.id, request, signal),
              });
              const trace = requiredRecord(result.trace, "evaluation trace");
              const evidence = requiredRecord(result.evaluationEvidence, "evaluation evidence");
              const attemptUsage = optionalUsage(evidence.policyUsage);
              if (attemptUsage) {
                policyUsageObserved = true;
                policyUsage.inputTokens += attemptUsage.inputTokens;
                policyUsage.outputTokens += attemptUsage.outputTokens;
                policyUsage.totalTokens += attemptUsage.totalTokens;
              }
              const attemptCost = optionalNonnegative(evidence.policyCostUsd);
              if (attemptCost !== null) policyUsage.costUsd = (policyUsage.costUsd ?? 0) + attemptCost;
              const score = finite(trace.reward, "deterministic score");
              const components = requiredRecord(trace.components, "deterministic components");
              const passed = finite(components.terminalState, "terminal state") === 1;
              attempts.push({ taskId: task.id, seed, repetition, status: "succeeded", deterministicScore: score, passed, judgeScore: null, judgePreference: null, transcriptHash: contentHash(evidence.messages), traceHash: requiredHash(trace.traceSha256), failureClass: null });
              evidenceAttempts.push({ taskId: task.id, seed, repetition, trace, evidence });
            } catch (error) {
              attempts.push({ taskId: task.id, seed, repetition, status: "failed", deterministicScore: null, passed: null, judgeScore: null, judgePreference: null, transcriptHash: null, traceHash: null, failureClass: classifyFailure(error) });
              evidenceAttempts.push({ taskId: task.id, seed, repetition, error: message(error) });
            }
            completed += 1;
            const current = await deps.store.getModelRun(input.run.id);
            if (current?.status === "running") {
              await deps.store.saveModelRun(ModelRunSchema.parse({ ...current, evaluationProgress: { ...current.evaluationProgress!, completedAttempts: completed }, updatedAt: new Date().toISOString() }));
            }
          }
        }
      }
      const finishedAt = new Date().toISOString();
      const succeeded = attempts.filter((attempt) => attempt.status === "succeeded");
      const passed = succeeded.filter((attempt) => attempt.passed).length;
      const evidenceContent = { schemaVersion: "openpond.modelComparisonEvidenceSnapshot.v1", runId: input.run.id, target: evaluation.target, taskset: input.run.taskset, grader: input.series.grader, attempts: evidenceAttempts, completedAt: finishedAt };
      const evidenceHash = contentHash(evidenceContent);
      const evidenceId = `comparison_evidence_${evidenceHash.slice(0, 24)}`;
      const evidenceDirectory = path.join(deps.storeDir, "training", "comparison-evaluations");
      const evidencePath = path.join(evidenceDirectory, `${evidenceId}.json`);
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidenceContent, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const scores = succeeded.map((attempt) => attempt.deterministicScore!).filter(Number.isFinite);
      const passRate = succeeded.length ? passed / succeeded.length : null;
      if (soak && access) soak = await currentSoak(access, fetchImpl, soak.job.id);
      const observedSpendUsd = soak ? optionalNonnegative(soak.job.accruedSpendUsd) : policyUsage.costUsd;
      const receiptContent = {
        schemaVersion: "openpond.modelComparisonBenchmarkReceipt.v1" as const,
        benchmarkId: "model-comparison" as const,
        target: evaluation.target,
        taskset: input.run.taskset,
        grader: input.series.grader,
        sampling: { seeds: evaluation.seeds, repetitions: evaluation.repetitions },
        deterministic: {
          attemptedTaskCount: attempts.length,
          completedTaskCount: succeeded.length,
          passedTaskCount: passed,
          failedTaskCount: succeeded.length - passed,
          meanScore: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
          passRate,
          passRateCi95: passRate === null ? null : wilsonInterval(passed, succeeded.length),
        },
        judge: null,
        attempts,
        usage: { policy: policyUsageObserved ? policyUsage : null, judge: null, observedSpendUsd },
        evidenceSnapshot: { id: evidenceId, contentHash: evidenceHash, artifactPath: evidencePath },
        completedAt: finishedAt,
      };
      const receipt = ModelComparisonBenchmarkReceiptSchema.parse({ ...receiptContent, contentHash: contentHash(receiptContent) });
      const current = await deps.store.getModelRun(input.run.id);
      const final = await deps.store.saveModelRun(ModelRunSchema.parse({ ...current!, status: "succeeded", receipt, evaluationProgress: { ...current!.evaluationProgress!, completedAttempts: attempts.length }, completedAt: finishedAt, updatedAt: finishedAt }));
      if (input.entry) await deps.comparisonSeries.linkRun({ entryId: input.entry.id, expectedStatus: input.entry.status as ModelComparisonEntryStatus, status: input.entry.status as ModelComparisonEntryStatus, evaluations: [{ evaluationRunId: final.id, modelVersionId: input.entry.modelVersionId!, taskset: input.run.taskset, grader: input.series.grader, cohortRole: input.cohortRole }] });
      return final;
    } catch (error) {
      const current = await deps.store.getModelRun(input.run.id) ?? input.run;
      const failedAt = new Date().toISOString();
      return deps.store.saveModelRun(ModelRunSchema.parse({ ...current, status: "failed", failure: message(error).slice(0, 5_000), completedAt: failedAt, updatedAt: failedAt }));
    } finally {
      if (codexPolicy) await codexPolicy.close().catch(() => undefined);
      if (access && soak) await cancelSoak(access, fetchImpl, soak).catch(() => undefined);
    }
  }

  async function reconcileInterrupted(): Promise<void> {
    const runs = (await deps.store.listModelRuns()).filter((run) => run.kind === "evaluation" && run.evaluation?.benchmarkId === "model-comparison" && (run.status === "prepared" || run.status === "running"));
    for (const run of runs) {
      const timestamp = new Date().toISOString();
      await deps.store.saveModelRun(ModelRunSchema.parse({ ...run, status: "failed", failure: "The local evaluation process restarted before it wrote a terminal receipt.", completedAt: timestamp, updatedAt: timestamp }));
    }
  }

  return { start, startReference, reconcileInterrupted, activeRun: (id: string) => active.get(id) ?? null };
}

async function requireEntry(store: SqliteStore, id: string) { const value = await store.getModelComparisonSeriesEntry(id); if (!value) throw new Error("Comparison entry was not found."); return value; }
async function requireSeries(store: SqliteStore, id: string) { const value = await store.getModelComparisonSeries(id); if (!value) throw new Error("Comparison Series was not found."); return value; }
function entryRef(entry: ModelComparisonSeriesEntry) { return { seriesId: entry.seriesId, entryId: entry.id, scheduleEntryId: entry.scheduleEntryId, releaseHash: entry.releaseHash, ordinal: entry.ordinal }; }
function cohortTaskset(series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry | null, role: CohortRole) { if (role === "current") { if (!entry) throw new Error("A reference evaluation requires a stable series cohort."); return entry.taskset; } if (role === "development") return series.evaluationTasksets.development; if (role === "retained") return series.evaluationTasksets.retained; if (role === "frozen_final") return series.evaluationTasksets.frozenFinal; throw new Error("Prior-disclosed evaluation requires an explicit Taskset release."); }

async function checkpointForEntry(store: SqliteStore, entry: ModelComparisonSeriesEntry): Promise<string> {
  const jobs = await store.listTrainingJobs();
  const job = jobs.find((candidate) => candidate.metadata.modelRunId === entry.modelRunId);
  if (!job) throw new Error("The candidate training Job was not found.");
  const checkpoint = (await store.listTrainingArtifacts(job.id)).find((artifact) => artifact.kind === "checkpoint");
  const id = optionalString(checkpoint?.metadata.managedRlOutputId);
  if (!id) throw new Error("The candidate checkpoint output identity is unavailable.");
  return id;
}

async function stableQuote(access: Access, fetchImpl: typeof fetch): Promise<SignedQuote> {
  const response = await requestJson<{ quotes: SignedQuote[] }>(access, fetchImpl, "/v1/managed-rl/quotes");
  const selected = response.quotes
    .filter((candidate) => candidate.imageVerified !== false && Number.isFinite(Number(candidate.quote.hourlyUsd)))
    .sort((a, b) =>
      (Number(a.quote.hourlyUsd) + Number(a.quote.diskHourlyUsd ?? 0))
      - (Number(b.quote.hourlyUsd) + Number(b.quote.diskHourlyUsd ?? 0))
    )[0];
  if (!selected) throw new Error("No supported GPU quote is currently available.");
  return selected;
}

function assertQuoteFitsCap(quote: SignedQuote, cap: number, seconds: number) { const hourly = Number(quote.quote.hourlyUsd) + Number(quote.quote.diskHourlyUsd ?? 0); if (hourly * (seconds / 3_600) + cap * 0.1 > cap) throw new Error("The selected GPU quote exceeds the caller-approved evaluation cap."); }

async function createSoak(input: { access: Access; fetchImpl: typeof fetch; checkpointId: string; requestCount: number; maximumSpendUsd: number; maxGpuSeconds: number; runId: string; quote: SignedQuote }): Promise<SoakStatus> {
  const response = await requestJson<{ job: { id: string; state: string; version: number } }>(input.access, input.fetchImpl, "/v1/managed-rl/serving-soaks", { method: "POST", body: JSON.stringify({ checkpointId: input.checkpointId, idempotencyKey: `comparison-evaluation-${contentHash({ runId: input.runId, checkpointId: input.checkpointId })}`, quote: input.quote.quote, quoteSignature: input.quote.quoteSignature, maximumSpendUsd: input.maximumSpendUsd, maxGpuSeconds: input.maxGpuSeconds, requests: Math.min(64, input.requestCount) }) });
  return { job: response.job, source: { policyVersion: 0, adapterSha256: "" }, serving: { state: "pending", policyVersion: null, adapterSha256: null } };
}

async function waitForSoak(access: Access, fetchImpl: typeof fetch, jobId: string, maxGpuSeconds: number): Promise<SoakStatus> {
  const deadline = Date.now() + maxGpuSeconds * 1_000;
  while (Date.now() < deadline) {
    const response = await requestJson<{ soak: SoakStatus }>(access, fetchImpl, `/v1/managed-rl/serving-soaks/${encodeURIComponent(jobId)}`);
    if (response.soak.job.state === "serving_soak_ready" && response.soak.serving.state === "ready") return response.soak;
    if (TERMINAL_SOAK_STATES.has(response.soak.job.state)) throw new Error(`Serving allocation terminated during initialization (${response.soak.job.state}).`);
    await delay(5_000);
  }
  throw new Error("Serving allocation did not become ready before its caller-approved deadline.");
}

async function currentSoak(access: Access, fetchImpl: typeof fetch, jobId: string): Promise<SoakStatus> {
  return (await requestJson<{ soak: SoakStatus }>(access, fetchImpl, `/v1/managed-rl/serving-soaks/${encodeURIComponent(jobId)}`)).soak;
}

async function cancelSoak(access: Access, fetchImpl: typeof fetch, soak: SoakStatus): Promise<void> { if (TERMINAL_SOAK_STATES.has(soak.job.state)) return; await requestJson(access, fetchImpl, `/v1/managed-rl/jobs/${encodeURIComponent(soak.job.id)}/cancel`, { method: "POST", body: JSON.stringify({ expectedVersion: soak.job.version }) }); }

async function policyRequest(access: Access, fetchImpl: typeof fetch, token: string, request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> { const response = await fetchImpl(`${access.apiBaseUrl}/v1/managed-rl/policy/chat/completions`, { method: "POST", headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(request), signal }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`Managed Policy request failed (${response.status}).`); return requiredRecord(payload, "Managed Policy response"); }

async function externalPolicyRequest(stream: TasksetWorkModelStream, model: ChatModelRef, runId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const messages = Array.isArray(request.messages) ? request.messages as Parameters<TasksetWorkModelStream>[0]["messages"] : [];
  const tools = Array.isArray(request.tools) ? request.tools as Parameters<TasksetWorkModelStream>[0]["tools"] : [];
  const accumulator = new NativeToolCallAccumulator();
  let text = "";
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let usageObserved = false;
  let costUsd = 0;
  let costObserved = false;
  const requestId = `${runId}:${String(request.deliveryId ?? "delivery")}:${String(request.turnIndex ?? 0)}`;
  for await (const delta of stream({ model, reasoningEffort: null, messages, tools, toolChoice: "auto", requestId, signal, maxOutputTokens: optionalPositive(request.maxTokens) ?? 1_024, temperature: optionalFinite(request.temperature) ?? 0.8, topP: 1, seed: optionalInteger(request.seed) ?? 0 })) {
    if (delta.text) text += delta.text;
    if (delta.toolCalls?.length) accumulator.append(delta.toolCalls);
    if (delta.usage !== undefined) {
      const normalized = normalizeModelUsageTokens(delta.usage);
      if (normalized.promptTokens !== null || normalized.completionTokens !== null || normalized.totalTokens !== null) {
        usageObserved = true;
        usage.promptTokens += normalized.promptTokens ?? 0;
        usage.completionTokens += normalized.completionTokens ?? 0;
        usage.totalTokens += normalized.totalTokens ?? (normalized.promptTokens ?? 0) + (normalized.completionTokens ?? 0);
      }
    }
    if (typeof delta.costUsd === "number" && Number.isFinite(delta.costUsd) && delta.costUsd >= 0) { costObserved = true; costUsd += delta.costUsd; }
  }
  const toolCalls = accumulator.completed().map((call) => call.hostedToolCall);
  return { response: { choices: [{ message: { content: text || null, tool_calls: toolCalls } }] }, trainingSample: { modelRequestId: requestId }, usage: usageObserved ? usage : undefined, costUsd: costObserved ? costUsd : undefined };
}

async function codexPolicyRequest(
  runtime: CodexTasksetPolicyRuntime,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return runtime.complete(request, signal);
}

async function requestJson<T>(access: Access, fetchImpl: typeof fetch, pathname: string, init: RequestInit = {}): Promise<T> { const headers = hostedApiAuthHeaders(access.token); headers.set("accept", "application/json"); headers.set("x-openpond-team-id", access.teamId); if (init.body) headers.set("content-type", "application/json"); const response = await fetchImpl(`${access.apiBaseUrl}${pathname}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(180_000) }); const payload = await response.json().catch(() => ({})); if (!response.ok) { const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {}; throw new Error(typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : `Managed RL request failed (${response.status}).`); } return payload as T; }

function wilsonInterval(successes: number, total: number) { const z = 1.959963984540054; const p = successes / total; const denominator = 1 + z * z / total; const center = (p + z * z / (2 * total)) / denominator; const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator; return { level: 0.95 as const, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) }; }
function classifyFailure(error: unknown): "policy" | "environment" | "grader" | "budget" | "harness" | "timeout" | "unknown" { const value = message(error).toLowerCase(); if (value.includes("policy")) return "policy"; if (value.includes("budget") || value.includes("spend")) return "budget"; if (value.includes("timeout") || value.includes("timed out")) return "timeout"; if (value.includes("grader") || value.includes("reward")) return "grader"; if (value.includes("tau3") || value.includes("bridge") || value.includes("harness")) return "harness"; if (value.includes("environment") || value.includes("tool")) return "environment"; return "unknown"; }
function requiredRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is unavailable.`); return value as Record<string, unknown>; }
function requiredHash(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Evaluation trace hash is invalid."); return value; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid.`); return value; }
function optionalString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function optionalNonnegative(value: unknown): number | null { const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN; return Number.isFinite(parsed) && parsed >= 0 ? parsed : null; }
function optionalUsage(value: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const usage = value as Record<string, unknown>; const inputTokens = optionalNonnegative(usage.inputTokens); const outputTokens = optionalNonnegative(usage.outputTokens); const totalTokens = optionalNonnegative(usage.totalTokens); return inputTokens === null || outputTokens === null || totalTokens === null ? null : { inputTokens, outputTokens, totalTokens }; }
function optionalPositive(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null; }
function optionalInteger(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : null; }
function optionalFinite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
