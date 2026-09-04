import { randomUUID } from "node:crypto";

import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import type { SqliteStore } from "../store/store.js";
import type { TaskDataRecord, Taskset } from "@openpond/contracts";
import "./marketing-portfolio-managed-rl-adapter.js";
import "./portable-jsonl-managed-rl-adapter.js";
import {
  resolveManagedRlHarnessAdapter,
  type ManagedRlLocalRolloutClaim,
} from "./managed-rl-harness-registry.js";

export type ManagedRlLocalExecutorAccess = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

type LocalRolloutClaim = ManagedRlLocalRolloutClaim;

type ClaimResponse = {
  jobState: string;
  claim: LocalRolloutClaim | null;
  claims?: LocalRolloutClaim[];
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
      harnessRoot: string;
      validationTaskset?: Taskset;
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
        const availableSlots = 4 - this.active.size;
        let response: ClaimResponse;
        try {
          response = await this.userRequest<ClaimResponse>(
            `/v1/managed-rl/jobs/${encodeURIComponent(this.input.runId)}/local-rollouts`,
            {
              method: "POST",
              body: JSON.stringify({
                executorId: this.executorId,
                maxClaims: availableSlots,
              }),
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
        const claims = response.claims ?? (response.claim ? [response.claim] : []);
        if (!claims.length) break;
        for (const claim of claims.slice(0, availableSlots)) {
          const execution = this.execute(claim)
            .catch((error) => {
              this._lastError = message(error);
            })
            .finally(() => this.active.delete(execution));
          this.active.add(execution);
        }
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
        await this.completeWithRetry(claim, managedRlSandboxCompletion(result));
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
    const taskset = await this.input.store.getTasksetRevision(
      claim.taskset.id,
      claim.taskset.revision,
      claim.taskset.contentHash,
    );
    if (!taskset) throw new Error("managed_rl_local_taskset_missing");
    const execution = resolveManagedRlExecutionTask({
      claimTaskId: claim.task.id,
      trainingTaskset: taskset,
      validationTaskset: this.input.validationTaskset,
    });
    const adapter = resolveManagedRlHarnessAdapter({
      taskset: execution.taskset,
      environmentId,
    });
    return adapter.execute({
      claim,
      taskset: execution.taskset,
      task: execution.task,
      harnessRoot: this.input.harnessRoot,
      storeDir: this.input.storeDir,
      executorId: this.executorId,
      signal: this.abortController.signal,
      policyRequest: (request, signal) => this.policyRequest(
        claim.policy.path,
        claim.policy.token,
        request,
        signal,
      ),
    });
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
      headers,
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
        headers,
        body: JSON.stringify(request),
        signal,
      },
    );
  }
}

export function resolveManagedRlExecutionTask(input: {
  claimTaskId: string;
  trainingTaskset: Taskset;
  validationTaskset?: Taskset;
}): { taskset: Taskset; task: TaskDataRecord } {
  const sources = [input.trainingTaskset, input.validationTaskset].filter(
    (taskset): taskset is Taskset => Boolean(taskset),
  );
  const matches = sources.flatMap((taskset) =>
    taskset.tasks
      .filter((task) => task.id === input.claimTaskId)
      .map((task) => ({ taskset, task })),
  );
  if (matches.length === 0) throw new Error("managed_rl_local_task_missing");
  if (matches.length > 1) {
    const [first, ...rest] = matches;
    if (rest.some((match) => JSON.stringify(match.task) !== JSON.stringify(first!.task))) {
      throw new Error("managed_rl_local_task_ambiguous");
    }
  }
  return matches[0]!;
}

export function managedRlSandboxCompletion(
  result: Record<string, unknown>,
): Record<string, unknown> {
  return {
    status: result.status,
    executorId: result.executorId,
    environmentSha256: result.environmentSha256,
    policyResult: result.policyResult,
    ...(Array.isArray(result.policyResults)
      ? { policyResults: result.policyResults }
      : {}),
    trace: result.trace,
  };
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
