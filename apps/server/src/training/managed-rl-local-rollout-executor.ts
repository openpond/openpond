import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { withVercelProtectionBypass } from "@openpond/cloud";
import type { OpenPondProfileState } from "@openpond/contracts";

import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import type { SqliteStore } from "../store/store.js";
import {
  parseManagedRlPolicyCompletion,
  runMarketingPortfolioRollout,
} from "./marketing-portfolio-rollout.js";
import { verifyMarketingPortfolioRuntime } from "./marketing-portfolio-runtime-verifier.js";
import { createProfileAgentHarnessRuntime } from "./profile-agent-harness-runtime.js";

export type ManagedRlLocalExecutorAccess = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

type LocalRolloutClaim = {
  schemaVersion: "openpond.managedRlLocalRolloutClaim.v1";
  executionKind: "rollout" | "evaluation";
  executionId: string;
  jobId: string;
  groupId: string | null;
  rolloutId: string | null;
  deliveryId: string;
  policyVersion: number;
  task: {
    id: string;
    expectedText: string | null;
  };
  taskset: {
    id: string;
    revision: number;
    contentHash: string;
  };
  harnessRelease: {
    id: string;
    contentHash: string;
  };
  reward:
    | { kind: "exact_text_v1" }
    | { kind: "local_harness_receipt_v1"; environmentId: string };
  environmentSha256: string;
  request: Record<string, unknown>;
  policy: {
    path: string;
    token: string;
  };
};

type ClaimResponse = {
  jobState: string;
  claim: LocalRolloutClaim | null;
};

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const EXECUTION_ATTEMPTS = 3;
const COMPLETION_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

export class ManagedRlLocalRolloutExecutor {
  readonly executorId: string;
  private readonly active = new Set<Promise<void>>();
  private stopped = false;
  private running: Promise<void> | null = null;
  private _lastError: string | null = null;
  private readonly abortController = new AbortController();

  constructor(
    private readonly input: {
      runId: string;
      access: ManagedRlLocalExecutorAccess;
      fetchImpl?: typeof fetch;
      executorId?: string;
      env?: Record<string, string | undefined>;
      store: SqliteStore;
      storeDir: string;
      loadProfileState: () => Promise<OpenPondProfileState>;
    },
  ) {
    this.executorId = input.executorId ?? `openpond-desktop:${randomUUID()}`;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  start(): void {
    if (this.running || this.stopped) return;
    this.running = this.loop().catch((error) => {
      this._lastError = message(error);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController.abort();
    await Promise.allSettled([...(this.running ? [this.running] : []), ...this.active]);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      while (!this.stopped && this.active.size < 4) {
        let response: ClaimResponse;
        try {
          response = await this.userRequest<ClaimResponse>(
            `/v1/managed-rl/jobs/${encodeURIComponent(this.input.runId)}/local-rollouts`,
            {
              method: "POST",
              body: JSON.stringify({ executorId: this.executorId }),
            },
          );
          this._lastError = null;
        } catch (error) {
          this._lastError = message(error);
          await delay(1_000);
          break;
        }
        if (TERMINAL_STATES.has(response.jobState)) {
          this.stopped = true;
          break;
        }
        if (!response.claim) break;
        const execution = this.execute(response.claim)
          .catch((error) => {
            this._lastError = message(error);
          })
          .finally(() => this.active.delete(execution));
        this.active.add(execution);
      }
      if (this.stopped) break;
      if (this.active.size > 0) {
        await Promise.race(this.active);
      } else {
        await delay(300);
      }
    }
  }

  private async execute(claim: LocalRolloutClaim): Promise<void> {
    let lastError: unknown = new Error("managed_rl_local_execution_failed");
    for (let attempt = 1; attempt <= EXECUTION_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.executeOnce(claim);
        await this.completeWithRetry(claim, result);
        return;
      } catch (error) {
        lastError = error;
        if (
          this.stopped ||
          this.abortController.signal.aborted ||
          attempt === EXECUTION_ATTEMPTS
        ) {
          break;
        }
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
    if (this.stopped || this.abortController.signal.aborted) {
      throw lastError;
    }
    await this.completeWithRetry(claim, {
      status: "failed",
      executorId: this.executorId,
      errorCode: sanitizeError(lastError),
    }).catch(() => undefined);
    throw lastError;
  }

  private async executeOnce(
    claim: LocalRolloutClaim,
  ): Promise<Record<string, unknown>> {
    if (claim.reward.kind === "local_harness_receipt_v1") {
      return this.executeLocalHarness(claim, claim.reward.environmentId);
    }
    const policyResult = await this.policyRequest(
      claim.policy.path,
      claim.policy.token,
      claim.request,
    );
    const output = policyContent(policyResult);
    if (claim.task.expectedText === null) {
      throw new Error("managed_rl_exact_text_expected_answer_missing");
    }
    const expected = normalizeText(claim.task.expectedText);
    return {
      status: "succeeded",
      executorId: this.executorId,
      environmentSha256: claim.environmentSha256,
      policyResult,
      trace: {
        taskId: claim.task.id,
        output,
        reward: output === expected ? 1 : 0,
      },
    };
  }

  private async executeLocalHarness(
    claim: LocalRolloutClaim,
    environmentId: string,
  ): Promise<Record<string, unknown>> {
    if (environmentId !== "marketing-portfolio-v1") {
      throw new Error(
        `managed_rl_local_harness_unsupported:${environmentId}`,
      );
    }
    const taskset = await this.input.store.getTasksetRevision(
      claim.taskset.id,
      claim.taskset.revision,
      claim.taskset.contentHash,
    );
    if (!taskset) throw new Error("managed_rl_local_taskset_missing");
    const task = taskset.tasks.find((candidate) => candidate.id === claim.task.id);
    if (!task) throw new Error("managed_rl_local_task_missing");
    const profile = await this.input.loadProfileState();
    const verified = await verifyMarketingPortfolioRuntime({
      taskset,
      profile,
    });
    const runtime = createProfileAgentHarnessRuntime({
      agentRoot: verified.agentRoot,
      scorerModulePath: verified.scorerModulePath,
      artifactRoot: path.join(
        this.input.storeDir,
        "training",
        "managed-rl-local",
        claim.jobId,
        claim.executionId,
      ),
    });
    const baseSeed =
      typeof claim.request.seed === "number" &&
      Number.isInteger(claim.request.seed)
        ? claim.request.seed
        : 0;
    const rollout = await runMarketingPortfolioRollout({
      taskset,
      task,
      runtime,
      signal: this.abortController.signal,
      policy: {
        complete: async ({
          turnIndex,
          messages,
          tools,
          requiredToolName,
          signal,
        }) => {
          const policyResult = await this.policyRequest(
            claim.policy.path,
            claim.policy.token,
            {
              deliveryId: claim.deliveryId,
              policyVersion: claim.policyVersion,
              turnIndex,
              messages,
              tools,
              toolChoice: managedRlNamedToolChoice(requiredToolName),
              maxTokens: 1_024,
              temperature: 0.8,
              seed: baseSeed + turnIndex,
              logprobs: true,
              topLogprobs: 1,
              returnTokenIds: true,
            },
            signal,
          );
          return {
            ...parseManagedRlPolicyCompletion(policyResult),
            policyResult,
          };
        },
      },
    });
    const trainingSample = record(
      rollout.policyResult.trainingSample,
      "Managed RL training sample",
    );
    const modelRequestId = requiredString(
      trainingSample.modelRequestId,
      "Managed RL model request ID",
    );
    return {
      status: "succeeded",
      executorId: this.executorId,
      environmentSha256: claim.environmentSha256,
      policyResult: rollout.policyResult,
      trace: {
        schemaVersion: "openpond.managedRlLocalHarnessReceipt.v1",
        jobId: claim.jobId,
        executionKind: claim.executionKind,
        executionId: claim.executionId,
        deliveryId: claim.deliveryId,
        groupId: claim.groupId,
        taskId: task.id,
        policyVersion: claim.policyVersion,
        environmentSha256: claim.environmentSha256,
        harnessReleaseSha256: claim.harnessRelease.contentHash,
        tasksetSha256: claim.taskset.contentHash,
        traceSha256: rollout.traceSha256,
        trainingSampleSha256: managedRlSha256(trainingSample),
        modelRequestId,
        reward: rollout.reward,
        components: rollout.components,
        terminal: rollout.terminal,
        toolSequence: rollout.toolSequence,
      },
    };
  }

  private async completeWithRetry(
    claim: LocalRolloutClaim,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let lastError: unknown = new Error("managed_rl_local_completion_failed");
    for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
      try {
        return await this.userRequest(
          `/v1/managed-rl/jobs/${encodeURIComponent(this.input.runId)}` +
            `/local-rollouts/${encodeURIComponent(claim.executionId)}/complete`,
          {
            method: "POST",
            body: JSON.stringify(result),
          },
        );
      } catch (error) {
        lastError = error;
        if (
          this.stopped ||
          this.abortController.signal.aborted ||
          attempt === COMPLETION_ATTEMPTS
        ) {
          break;
        }
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
    throw lastError;
  }

  private async userRequest<T>(path: string, init: RequestInit): Promise<T> {
    const headers = hostedApiAuthHeaders(this.input.access.token);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("x-openpond-team-id", this.input.access.teamId);
    const requestUrl = `${this.input.access.apiBaseUrl}${path}`;
    return requestJson<T>(this.input.fetchImpl ?? fetch, requestUrl, {
      ...init,
      headers: withVercelProtectionBypass(requestUrl, headers, this.input.env),
      signal: this.abortController.signal,
    });
  }

  private policyRequest(
    path: string,
    token: string,
    request: Record<string, unknown>,
    signal: AbortSignal = this.abortController.signal,
  ): Promise<Record<string, unknown>> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    const requestUrl = `${this.input.access.apiBaseUrl}${path}`;
    return requestJson<Record<string, unknown>>(
      this.input.fetchImpl ?? fetch,
      requestUrl,
      {
        method: "POST",
        headers: withVercelProtectionBypass(requestUrl, headers, this.input.env),
        body: JSON.stringify(request),
        signal,
      },
    );
  }
}

export function managedRlNamedToolChoice(requiredToolName: string): {
  type: "function";
  function: { name: string };
} {
  if (!requiredToolName.trim()) {
    throw new Error("managed_rl_required_tool_name_missing");
  }
  return {
    type: "function",
    function: { name: requiredToolName },
  };
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : `Managed RL desktop executor request failed (${response.status}).`,
    );
  }
  return payload as T;
}

function policyContent(result: Record<string, unknown>): string {
  const response = result.response;
  const choices =
    response && typeof response === "object" && !Array.isArray(response)
      ? Reflect.get(response, "choices")
      : null;
  const first = Array.isArray(choices) ? choices[0] : null;
  const message =
    first && typeof first === "object" && !Array.isArray(first)
      ? Reflect.get(first, "message")
      : null;
  const content =
    message && typeof message === "object" && !Array.isArray(message)
      ? Reflect.get(message, "content")
      : null;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("managed_rl_policy_content_missing");
  }
  return normalizeText(content);
}

function normalizeText(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
    .normalize("NFC");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function managedRlSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function sanitizeError(error: unknown): string {
  return message(error)
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .slice(0, 120);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
