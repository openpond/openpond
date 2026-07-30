import { describe, expect, test, vi } from "vitest";

import {
  ManagedRlLocalRolloutExecutor,
  managedRlNamedToolChoice,
} from "../apps/server/src/training/managed-rl-local-rollout-executor.js";

describe("Managed RL desktop rollout executor", () => {
  test("binds each ordered harness turn to its exact required tool", () => {
    expect(managedRlNamedToolChoice("submit_budget_decision")).toEqual({
      type: "function",
      function: { name: "submit_budget_decision" },
    });
    expect(() => managedRlNamedToolChoice("  ")).toThrow(
      "managed_rl_required_tool_name_missing",
    );
  });

  test("claims, executes, locally scores, and completes a rollout", async () => {
    const completions: Array<Record<string, unknown>> = [];
    let claimCount = 0;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/v1/managed-rl/jobs/job-local-1/local-rollouts" &&
        (init?.method ?? "GET") === "POST"
      ) {
        claimCount += 1;
        if (claimCount > 1) {
          return json({ jobState: "completed", claim: null });
        }
        expect(new Headers(init?.headers).get("x-openpond-team-id")).toBe("team-test");
        expect(new Headers(init?.headers).get("x-vercel-protection-bypass")).toBe(
          "staging-bypass",
        );
        return json({
          jobState: "rollout_phase",
          claim: {
            schemaVersion: "openpond.managedRlLocalRolloutClaim.v1",
            executionKind: "rollout",
            executionId: "rollout-1",
            jobId: "job-local-1",
            groupId: "group-1",
            rolloutId: "rollout-1",
            deliveryId: "delivery-1",
            policyVersion: 0,
            task: {
              id: "task-1",
              expectedText: "accepted",
            },
            taskset: {
              id: "taskset-1",
              revision: 1,
              contentHash: "b".repeat(64),
            },
            harnessRelease: {
              id: "harness-1",
              contentHash: "c".repeat(64),
            },
            reward: {
              kind: "exact_text_v1",
            },
            environmentSha256: "a".repeat(64),
            request: {
              deliveryId: "delivery-1",
              policyVersion: 0,
              messages: [{ role: "user", content: "Return accepted" }],
            },
            policy: {
              path: "/v1/managed-rl/policy/chat/completions",
              token: "policy-token",
            },
          },
        });
      }
      if (url.pathname === "/v1/managed-rl/policy/chat/completions") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer policy-token");
        return json({
          servedPolicyVersion: 0,
          response: {
            choices: [{ message: { content: " accepted " } }],
          },
          trainingSample: {
            schemaVersion: "openpond.managedRlTrainingSample.v1",
            tokenIds: [1, 2],
            mask: [false, true],
            logprobs: [-0.2, -0.1],
            temperatures: [0.8, 0.8],
            envName: "task-1",
            modelRequestId: "request-1",
            promptTokenCount: 1,
            completionTokenCount: 1,
            servedPolicyVersion: 0,
          },
        });
      }
      if (url.pathname === "/v1/managed-rl/jobs/job-local-1/local-rollouts/rollout-1/complete") {
        completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({
          rolloutId: "rollout-1",
          completed: true,
          groupState: "eligible",
        });
      }
      return json({ error: "unexpected_request" }, 500);
    });
    const executor = new ManagedRlLocalRolloutExecutor({
      runId: "job-local-1",
      access: {
        apiBaseUrl: "https://api-new.staging-api.openpond.ai",
        token: "user-token",
        teamId: "team-test",
      },
      fetchImpl: request,
      executorId: "openpond-desktop:test-executor",
      env: {
        VERCEL_AUTOMATION_BYPASS_SECRET: "staging-bypass",
      },
      store: {} as never,
      storeDir: "/tmp/openpond-test-store",
      loadProfileState: async () => {
        throw new Error("Exact-text rollout must not load a Profile.");
      },
    });

    executor.start();
    await waitFor(() => completions.length === 1);
    await executor.stop();

    expect(completions).toEqual([
      expect.objectContaining({
        status: "succeeded",
        executorId: "openpond-desktop:test-executor",
        environmentSha256: "a".repeat(64),
        trace: {
          taskId: "task-1",
          output: "accepted",
          reward: 1,
        },
      }),
    ]);
    expect(executor.lastError).toBeNull();
  });

  test("replays an idempotent execution and completion after transient failures", async () => {
    let claimCount = 0;
    let policyCount = 0;
    let completionCount = 0;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/v1/managed-rl/jobs/job-retry-1/local-rollouts" &&
        (init?.method ?? "GET") === "POST"
      ) {
        claimCount += 1;
        if (claimCount > 1) {
          return json({
            jobState:
              completionCount === 2 ? "completed" : "rollout_phase",
            claim: null,
          });
        }
        return json({
          jobState: "rollout_phase",
          claim: {
            schemaVersion: "openpond.managedRlLocalRolloutClaim.v1",
            executionKind: "rollout",
            executionId: "rollout-retry-1",
            jobId: "job-retry-1",
            groupId: "group-retry-1",
            rolloutId: "rollout-retry-1",
            deliveryId: "delivery-retry-1",
            policyVersion: 0,
            task: {
              id: "task-retry-1",
              expectedText: "accepted",
            },
            taskset: {
              id: "taskset-retry-1",
              revision: 1,
              contentHash: "b".repeat(64),
            },
            harnessRelease: {
              id: "harness-retry-1",
              contentHash: "c".repeat(64),
            },
            reward: {
              kind: "exact_text_v1",
            },
            environmentSha256: "a".repeat(64),
            request: {
              deliveryId: "delivery-retry-1",
              policyVersion: 0,
              messages: [{ role: "user", content: "Return accepted" }],
            },
            policy: {
              path: "/v1/managed-rl/policy/chat/completions",
              token: "policy-token",
            },
          },
        });
      }
      if (url.pathname === "/v1/managed-rl/policy/chat/completions") {
        policyCount += 1;
        if (policyCount === 1) {
          throw new Error("Unexpected end of JSON input");
        }
        return json({
          servedPolicyVersion: 0,
          response: {
            choices: [{ message: { content: "accepted" } }],
          },
          trainingSample: {
            schemaVersion: "openpond.managedRlTrainingSample.v1",
            tokenIds: [1, 2],
            mask: [false, true],
            logprobs: [-0.2, -0.1],
            temperatures: [0.8, 0.8],
            envName: "task-retry-1",
            modelRequestId: "request-retry-1",
            promptTokenCount: 1,
            completionTokenCount: 1,
            servedPolicyVersion: 0,
          },
        });
      }
      if (
        url.pathname ===
        "/v1/managed-rl/jobs/job-retry-1/local-rollouts/rollout-retry-1/complete"
      ) {
        completionCount += 1;
        if (completionCount === 1) {
          return json({ error: "transient_completion_failure" }, 503);
        }
        return json({
          rolloutId: "rollout-retry-1",
          completed: true,
          groupState: "eligible",
        });
      }
      return json({ error: "unexpected_request" }, 500);
    });
    const executor = new ManagedRlLocalRolloutExecutor({
      runId: "job-retry-1",
      access: {
        apiBaseUrl: "https://api-new.staging-api.openpond.ai",
        token: "user-token",
        teamId: "team-test",
      },
      fetchImpl: request,
      executorId: "openpond-desktop:test-retry-executor",
      store: {} as never,
      storeDir: "/tmp/openpond-test-store",
      loadProfileState: async () => {
        throw new Error("Exact-text rollout must not load a Profile.");
      },
    });

    executor.start();
    await waitFor(() => completionCount === 2);
    await executor.stop();

    expect(policyCount).toBe(2);
    expect(completionCount).toBe(2);
    expect(executor.lastError).toBeNull();
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
