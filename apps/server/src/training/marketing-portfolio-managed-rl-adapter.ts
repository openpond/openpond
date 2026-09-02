import { createHash } from "node:crypto";
import path from "node:path";

import { createAttemptReceipt, type AttemptReceipt } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import type { Taskset } from "@openpond/contracts";

import { parseManagedRlPolicyCompletion, runMarketingPortfolioRollout } from "./marketing-portfolio-rollout.js";
import {
  registerManagedRlHarnessAdapter,
  type ManagedRlHarnessExecutionInput,
} from "./managed-rl-harness-registry.js";
import { verifyMarketingPortfolioRuntime } from "./marketing-portfolio-runtime-verifier.js";
import { createProfileAgentHarnessRuntime } from "./profile-agent-harness-runtime.js";

export const MARKETING_PORTFOLIO_HARNESS_ADAPTER_ID = "marketing-portfolio-v1";

export const marketingPortfolioManagedRlAdapter = {
  id: MARKETING_PORTFOLIO_HARNESS_ADAPTER_ID,
  priority: 100,
  supports(input: { taskset: Taskset; environmentId: string }): boolean {
    const benchmark = input.taskset.environment.metadata.benchmark;
    const benchmarkId = benchmark && typeof benchmark === "object" && !Array.isArray(benchmark)
      ? Reflect.get(benchmark, "id")
      : null;
    const tools = (input.taskset.environment.actionBindings ?? []).map((binding) => binding.modelToolName);
    return input.environmentId === MARKETING_PORTFOLIO_HARNESS_ADAPTER_ID
      && benchmarkId === MARKETING_PORTFOLIO_HARNESS_ADAPTER_ID
      && tools.join(",") === "get_portfolio_snapshot,submit_budget_decision";
  },
  execute: executeMarketingPortfolioManagedRl,
};

registerManagedRlHarnessAdapter(marketingPortfolioManagedRlAdapter);

export async function executeMarketingPortfolioManagedRl(input: ManagedRlHarnessExecutionInput): Promise<Record<string, unknown>> {
  const verified = await verifyMarketingPortfolioRuntime({ taskset: input.taskset, harnessRoot: input.harnessRoot });
  const runtime = createProfileAgentHarnessRuntime({
    agentRoot: verified.agentRoot,
    scorerModulePath: verified.scorerModulePath,
    artifactRoot: path.join(input.storeDir, "training", "managed-rl-local", input.claim.jobId, input.claim.executionId),
  });
  const baseSeed = typeof input.claim.request.seed === "number" && Number.isInteger(input.claim.request.seed)
    ? input.claim.request.seed
    : 0;
  const startedAt = (input.timestamp ?? (() => new Date().toISOString()))();
  const rollout = await runMarketingPortfolioRollout({
    taskset: input.taskset,
    task: input.task,
    runtime,
    signal: input.signal,
    policy: {
      complete: async ({ turnIndex, messages, tools, requiredToolName, signal }) => {
        const policyResult = await input.policyRequest({
          deliveryId: input.claim.deliveryId,
          policyVersion: input.claim.policyVersion,
          turnIndex,
          messages,
          tools,
          toolChoice: { type: "function", function: { name: requiredToolName } },
          maxTokens: 1_024,
          temperature: 0.8,
          seed: baseSeed + turnIndex,
          logprobs: true,
          topLogprobs: 1,
          returnTokenIds: true,
        }, signal);
        return { ...parseManagedRlPolicyCompletion(policyResult), policyResult };
      },
    },
  });
  const trainingSample = record(rollout.policyResult.trainingSample, "Managed RL training sample");
  const modelRequestId = requiredString(trainingSample.modelRequestId, "Managed RL model request ID");
  const trace = {
    schemaVersion: "openpond.managedRlLocalHarnessReceipt.v1",
    jobId: input.claim.jobId,
    executionKind: input.claim.executionKind,
    executionId: input.claim.executionId,
    deliveryId: input.claim.deliveryId,
    groupId: input.claim.groupId,
    taskId: input.task.id,
    policyVersion: input.claim.policyVersion,
    environmentSha256: input.claim.environmentSha256,
    harnessReleaseSha256: input.claim.harnessRelease.contentHash,
    tasksetSha256: input.claim.taskset.contentHash,
    traceSha256: rollout.traceSha256,
    trainingSampleSha256: sha256(trainingSample),
    modelRequestId,
    reward: rollout.reward,
    components: rollout.components,
    terminal: rollout.terminal,
    toolSequence: rollout.toolSequence,
  };
  const completedAt = (input.timestamp ?? (() => new Date().toISOString()))();
  const receipt = createManagedRlHarnessAttemptReceipt({
    claim: input.claim,
    taskId: input.task.id,
    seed: baseSeed,
    rollout,
    startedAt,
    completedAt,
  });
  return {
    status: "succeeded",
    executorId: input.executorId,
    environmentSha256: input.claim.environmentSha256,
    policyResult: rollout.policyResult,
    trace,
    attemptReceipt: receipt,
  };
}

export function createManagedRlHarnessAttemptReceipt(input: {
  claim: ManagedRlHarnessExecutionInput["claim"];
  taskId: string;
  seed: number;
  rollout: {
    traceSha256: string;
    reward: number;
    components: Record<string, number>;
    terminal: boolean;
    toolSequence: string[];
  };
  startedAt: string;
  completedAt: string;
}): AttemptReceipt {
  const graderEvidence = {
    id: `grader-${input.claim.executionId}`,
    contentHash: contentHash({ reward: input.rollout.reward, components: input.rollout.components }),
    mediaType: "application/vnd.openpond.grader-evidence+json",
    sizeBytes: null,
  };
  return createAttemptReceipt({
    schemaVersion: "openpond.attemptReceipt.v1",
    id: `receipt-${contentHash([input.claim.executionId, input.rollout.traceSha256]).slice(0, 24)}`,
    runManifest: {
      id: `managed-run-${input.claim.executionId}`,
      contentHash: contentHash({
        harnessRelease: input.claim.harnessRelease,
        tasksetRelease: input.claim.taskset,
        policyVersion: input.claim.policyVersion,
        environmentSha256: input.claim.environmentSha256,
      }),
    },
    taskId: input.taskId,
    seed: String(input.seed),
    terminal: input.rollout.terminal,
    failureClass: input.rollout.terminal ? null : "policy_failure",
    outputHash: contentHash({ reward: input.rollout.reward, components: input.rollout.components, toolSequence: input.rollout.toolSequence }),
    traceHash: hash(input.rollout.traceSha256),
    artifactRefs: [],
    graderEvidenceRefs: [graderEvidence],
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    latencyMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt)),
    costUsd: null,
    legacyAttemptRef: input.claim.executionId,
    metadata: { reward: input.rollout.reward, score: input.rollout.reward, rewardEligible: true, passed: input.rollout.terminal },
  });
}

function hash(value: string): string { return /^[a-f0-9]{64}$/.test(value) ? value : contentHash(value); }
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}
