import { TaskAttemptResultSchema, type Taskset } from "@openpond/contracts";
import { runJavaScriptEnvironmentAttempt } from "@openpond/evals/javascript-environment/attempt";
import { executeJavaScriptEnvironmentInWorker } from "@openpond/evals/javascript-environment/node";
import { learningRef } from "@openpond/evals/learning";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import type { TrainingEvaluationAttemptInput } from "./task-evaluation-attempt-runner.js";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-types.js";
import { loadStarterToolEnvironment } from "./starter-tool-environment.js";
import { createStarterToolPolicy } from "./starter-tool-policy.js";
import { persistJsonTaskAttemptArtifact } from "./task-attempt-artifact-service.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";

export async function runStarterToolAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  taskset: Taskset;
  attemptInput: TrainingEvaluationAttemptInput;
  stream: TasksetWorkModelStream;
  timestamp: () => string;
  resultId?: string;
  policySource?: "model" | "fixture";
  hostedTokenPricing?: HostedTokenPricing;
}) {
  const { attemptInput, taskset } = input;
  const modelRef = input.policySource === "fixture" ? null : attemptInput.model;
  const resolved = await loadStarterToolEnvironment(input.store, taskset, attemptInput.task);
  const startedAt = input.timestamp();
  const requestId = `starter-tool-${contentHash({ taskset: learningRef(taskset), task: attemptInput.task.id, model: modelRef, seed: attemptInput.seed, attempt: attemptInput.attempt, startedAt }).slice(0, 32)}`;
  const attemptId = input.resultId ?? requestId;
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(taskset.id) || !/^[a-zA-Z0-9_-]{1,200}$/.test(attemptId)) throw new Error("Tool attempt identifiers must be safe artifact identities.");
  const provider = createStarterToolPolicy({ stream: input.stream, model: attemptInput.model, reasoningEffort: attemptInput.reasoningEffort, requestId, seed: attemptInput.seed + attemptInput.attempt, sampling: attemptInput.sampling, hostedTokenPricing: input.hostedTokenPricing });
  const result = await runJavaScriptEnvironmentAttempt({
    taskId: attemptInput.task.id, definition: resolved.execution.javascript,
    asset: resolved.module, initialState: resolved.initialState, input: attemptInput.task.input,
    instructions: `${resolved.instructions}\n${JSON.stringify({ policyVisibleContext: attemptInput.task.policyVisibleContext })}`,
    seed: attemptInput.seed, timeoutMs: resolved.execution.environment.contract.defaultTimeoutMs,
    signal: attemptInput.signal, execute: executeJavaScriptEnvironmentInWorker, policy: provider.policy,
  });
  const completedAt = input.timestamp();
  const infrastructureError = ["environment_failure", "timed_out", "cancelled"].includes(result.status)
    ? result.error ?? result.status : null;
  const payload = {
    schemaVersion: "openpond.starterToolAttempt.v1", taskset: learningRef(taskset), taskHash: contentHash(attemptInput.task),
    model: modelRef, seed: attemptInput.seed, attempt: attemptInput.attempt, policySource: input.policySource ?? "model",
    definition: resolved.definition, environment: learningRef(resolved.execution.environment),
    verifierSet: learningRef(resolved.execution.verifierSet), result,
  };
  assertBoundedTaskJson(payload, 12_582_912);
  const artifact = await persistJsonTaskAttemptArtifact({
    store: input.store, storeDir: input.storeDir, tasksetId: taskset.id, taskId: attemptInput.task.id,
    attemptId, requestId, kind: "environment_state", payload, timestamp: input.timestamp,
  });
  return TaskAttemptResultSchema.parse({
    schemaVersion: "openpond.taskAttempt.v1", id: attemptId, tasksetId: taskset.id, taskId: attemptInput.task.id,
    split: attemptInput.task.split, attempt: attemptInput.attempt, seed: attemptInput.seed,
    modelRef, startedAt, completedAt, output: { text: result.output ?? "" },
    runtimeEventRefs: [], artifactRefs: [artifact.id], privilegedOutcomeRef: artifact.id,
    infrastructureError, costUsd: provider.costUsd(),
    latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), userInterventions: 0,
    metadata: { requestId, execution: "starter_tool_environment", policySource: input.policySource ?? "model", environmentStatus: result.status, environmentCleanupComplete: result.environmentCleanupComplete, environmentAttemptHash: result.contentHash },
  });
}
