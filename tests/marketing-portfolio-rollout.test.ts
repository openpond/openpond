import type {
  HarnessActionBinding,
  HarnessBundleProjection,
  HarnessExecutionBundleManifest,
  PrimeRolloutAssignment,
  TaskDataRecord,
  Taskset,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test, vi } from "vitest";

import {
  createOpenAiCompatibleMarketingPolicy,
  runMarketingPortfolioRollout,
  type MarketingPortfolioPolicy,
} from "../apps/server/src/training/marketing-portfolio-rollout.ts";
import {
  projectPubliclyFeasibleAllocation,
} from "../apps/server/src/training/marketing-portfolio-constraint-repair.ts";

describe("marketing portfolio Harness rollout", () => {
  test("runs both pinned tools, privately injects the case, sanitizes observations, and grades terminal state", async () => {
    const agentRelease = {
      id: "agent_marketing",
      contentHash: sha256("agent-release"),
    };
    const bindings = actionBindings(agentRelease);
    const profileRelease = {
      id: "profile_test",
      revision: 1,
      contentHash: sha256("profile-release"),
    };
    const task: TaskDataRecord = {
      schemaVersion: "openpond.taskData.v1",
      id: "task_train_1",
      clusterKey: "train-family",
      split: "train",
      input: { prompt: "Inspect the portfolio and submit a decision." },
      expectedOutput: null,
      policyVisibleContext: { family: "train-family" },
      privilegedContextRef: "case_ref",
      sourceRefs: ["source_1"],
      tags: [],
      metadata: { caseId: "cmo_train_1" },
    };
    const taskset = {
      id: "marketing-taskset",
      revision: 1,
      contentHash: sha256("taskset"),
      profileRelease,
      environment: {
        actionBindings: bindings,
        metadata: {
          benchmark: {
            scorer: {
              implementationHash: sha256("scorer"),
            },
          },
        },
      },
      tasks: [task],
    } as unknown as Taskset;
    const assignmentContent = {
      schemaVersion: "openpond.primeRolloutAssignment.v1" as const,
      runId: "prime_rollout_test",
      resolvedBundleHash: sha256("bundle"),
      taskset: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
      harnessRelease: {
        id: "harness_test",
        contentHash: sha256("harness"),
      },
      profileRelease,
      agentRelease,
      taskId: task.id,
      split: "train" as const,
      policyVersion: "base" as const,
      model: {
        id: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      },
      inferencePort: 8_000,
      createdAt: "2026-07-25T12:00:00.000Z",
    };
    const assignment: PrimeRolloutAssignment = {
      ...assignmentContent,
      assignmentHash: contentHash(assignmentContent),
    };
    const observedMessages: string[] = [];
    const requiredToolNames: string[] = [];
    let completion = 0;
    const policy: MarketingPortfolioPolicy = {
      complete: vi.fn(async ({ messages, requiredToolName }) => {
        observedMessages.push(JSON.stringify(messages));
        requiredToolNames.push(requiredToolName);
        completion += 1;
        return completion === 1
          ? {
              content: null,
              toolCalls: [{
                id: "snapshot_call",
                name: "get_portfolio_snapshot",
                arguments: "{}",
              }],
            }
          : {
              content: null,
              toolCalls: [{
                id: `decision_call_${completion}`,
                name: "submit_budget_decision",
                arguments: JSON.stringify({
                  allocations: completion === 2
                    ? [
                        { channelId: "paid_search", amountUsd: 40_000 },
                        { channelId: "paid_social", amountUsd: 40_000 },
                        { channelId: "streaming_video", amountUsd: 40_000 },
                        { channelId: "lifecycle", amountUsd: 40_000 },
                      ]
                    : [
                        { channelId: "paid_search", amountUsd: 1_000 },
                        { channelId: "paid_social", amountUsd: 1_000 },
                        { channelId: "streaming_video", amountUsd: 1_000 },
                        { channelId: "lifecycle", amountUsd: 1_000 },
                      ],
                  rationale:
                    "Allocate across paid search, paid social, streaming video, and lifecycle using visible efficiency and confidence.",
                  riskControls: ["brand_safety"],
                }),
              }],
            };
      }),
    };
    let decisionAttempts = 0;
    const executeAction = vi.fn(async ({ binding, arguments: args }) => {
      expect(args.scenarioId).toBe("cmo_train_1");
      if (binding.actionId === "get-portfolio-snapshot") {
        return {
          output: {
            scenarioId: "cmo_train_1",
            split: "train",
            incrementalBudgetUsd: 100_000,
            allocationIncrementUsd: 1_000,
            channelLimits: [
              {
                channelId: "paid_search",
                minimumUsd: 5_000,
                maximumUsd: 70_000,
              },
              {
                channelId: "paid_social",
                minimumUsd: 5_000,
                maximumUsd: 60_000,
              },
              {
                channelId: "streaming_video",
                minimumUsd: 5_000,
                maximumUsd: 50_000,
              },
              {
                channelId: "lifecycle",
                minimumUsd: 5_000,
                maximumUsd: 50_000,
              },
            ],
          },
          terminal: false,
        };
      }
      decisionAttempts += 1;
      return decisionAttempts === 1
        ? {
            output: {
              scenarioId: "cmo_train_1",
              accepted: false,
              errors: [
                "Allocation total 160000 must equal 100000.",
              ],
            },
            terminal: false,
          }
        : {
            output: {
              scenarioId: "cmo_train_1",
              accepted: true,
            },
            terminal: true,
          };
    });
    const scoreDecision = vi.fn(async (decision: Record<string, unknown>) => {
      expect(decision.scenarioId).toBe("cmo_train_1");
      return {
        reward: 0.75,
        components: {
          constraints: 1,
          portfolioValue: 0.7,
          riskControls: 0.5,
          rationale: 1,
        },
        validation: { accepted: true },
      };
    });

    const result = await runMarketingPortfolioRollout({
      assignment,
      taskset,
      task,
      studentManifest: manifest("student", bindings),
      environmentManifest: manifest("environment", bindings),
      policy,
      executeAction,
      scoreDecision,
      timestamp: () => "2026-07-25T12:01:00.000Z",
    });

    expect(result.status).toBe("succeeded");
    expect(result.terminal).toBe(true);
    expect(result.toolSequence).toEqual([
      "get_portfolio_snapshot",
      "submit_budget_decision",
      "submit_budget_decision",
    ]);
    expect(requiredToolNames).toEqual([
      "get_portfolio_snapshot",
      "submit_budget_decision",
      "submit_budget_decision",
    ]);
    expect(result.toolTrace).toHaveLength(3);
    expect(result.toolTrace[2]).toMatchObject({
      toolName: "submit_budget_decision",
      publicProjectionApplied: true,
      policyArguments: {
        allocations: [
          { channelId: "paid_search", amountUsd: 1_000 },
          { channelId: "paid_social", amountUsd: 1_000 },
          { channelId: "streaming_video", amountUsd: 1_000 },
          { channelId: "lifecycle", amountUsd: 1_000 },
        ],
      },
      executedArguments: {
        allocations: [
          { channelId: "paid_search", amountUsd: 25_000 },
          { channelId: "paid_social", amountUsd: 25_000 },
          { channelId: "streaming_video", amountUsd: 25_000 },
          { channelId: "lifecycle", amountUsd: 25_000 },
        ],
      },
      terminal: true,
    });
    expect(result.grade?.reward).toBe(0.75);
    expect(executeAction).toHaveBeenCalledTimes(3);
    expect(scoreDecision).toHaveBeenCalledTimes(1);
    expect(observedMessages[1]).not.toContain("cmo_train_1");
    expect(observedMessages[1]).not.toContain("scenarioId");
    expect(observedMessages[2]).toContain(
      "Allocation total 160000 must equal 100000.",
    );
    expect(observedMessages[2]).toContain(
      "public-constraint-only projection",
    );
    expect(observedMessages[2]).toContain(
      'amountUsd\\":25000',
    );
    expect(observedMessages[2]).not.toContain("cmo_train_1");
    const { resultHash, ...resultContent } = result;
    expect(resultHash).toBe(contentHash(resultContent));

    const incomplete = await runMarketingPortfolioRollout({
      assignment,
      taskset,
      task,
      studentManifest: manifest("student", bindings),
      environmentManifest: manifest("environment", bindings),
      policy: {
        complete: vi.fn(async () => ({
          content: "I cannot complete the task.",
          toolCalls: [],
        })),
      },
      executeAction,
      scoreDecision,
      maxTurns: 1,
      timestamp: () => "2026-07-25T12:02:00.000Z",
    });

    expect(incomplete.status).toBe("succeeded");
    expect(incomplete.terminal).toBe(false);
    expect(incomplete.grade).toMatchObject({
      decisionAccepted: false,
      reward: 0,
      components: {
        constraints: 0,
        portfolioValue: 0,
        riskControls: 0,
        rationale: 0,
      },
    });
    expect(incomplete.failure).toBeNull();
    expect(scoreDecision).toHaveBeenCalledTimes(1);
  });

  test("projects invalid policy amounts onto public constraints without scorer data", () => {
    expect(projectPubliclyFeasibleAllocation({
      snapshot: {
        incrementalBudgetUsd: 108_000,
        allocationIncrementUsd: 1_000,
        channelLimits: [
          {
            channelId: "paid_search",
            minimumUsd: 3_000,
            maximumUsd: 71_000,
          },
          {
            channelId: "paid_social",
            minimumUsd: 6_000,
            maximumUsd: 53_000,
          },
          {
            channelId: "streaming_video",
            minimumUsd: 5_000,
            maximumUsd: 45_000,
          },
          {
            channelId: "lifecycle",
            minimumUsd: 5_000,
            maximumUsd: 50_000,
          },
        ],
      },
      decision: {
        allocations: [
          { channelId: "paid_search", amountUsd: 10_000 },
          { channelId: "paid_social", amountUsd: 10_000 },
          { channelId: "streaming_video", amountUsd: 10_000 },
          { channelId: "lifecycle", amountUsd: 10_000 },
        ],
      },
    })).toEqual({
      allocations: [
        { channelId: "paid_search", amountUsd: 27_000 },
        { channelId: "paid_social", amountUsd: 27_000 },
        { channelId: "streaming_video", amountUsd: 27_000 },
        { channelId: "lifecycle", amountUsd: 27_000 },
      ],
      incrementalBudgetUsd: 108_000,
      allocationIncrementUsd: 1_000,
      allocationTotalUsd: 108_000,
    });
  });

  test("captures vLLM token IDs, original logprobs, request identity, and monotonic timing", async () => {
    let submitted: Record<string, unknown> | null = null;
    const policy = createOpenAiCompatibleMarketingPolicy({
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "Qwen/Qwen3-0.6B",
      captureOptimizerSample: true,
      seed: 20_017,
      request: async (_url, init) => {
        submitted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          id: "chatcmpl-token-proof",
          model: "Qwen/Qwen3-0.6B",
          prompt_token_ids: [1, 2, 3],
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-1",
                function: {
                  name: "get_portfolio_snapshot",
                  arguments: "{}",
                },
              }],
            },
            token_ids: [4, 5],
            logprobs: {
              content: [
                { token: "a", logprob: -0.1 },
                { token: "b", logprob: -0.2 },
              ],
            },
          }],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 2,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const completion = await policy.complete({
      messages: [{ role: "user", content: "Use the tool." }],
      tools: [],
      requiredToolName: "get_portfolio_snapshot",
      signal: new AbortController().signal,
    });

    expect(submitted).toMatchObject({
      tool_choice: {
        type: "function",
        function: { name: "get_portfolio_snapshot" },
      },
      parallel_tool_calls: false,
      logprobs: true,
      top_logprobs: 0,
      return_token_ids: true,
      seed: 20_017,
    });
    expect(completion.samplingTrace).toMatchObject({
      requestId: "chatcmpl-token-proof",
      servedModel: "Qwen/Qwen3-0.6B",
      promptTokenIds: [1, 2, 3],
      generatedTokenIds: [4, 5],
      generatedLogprobs: [-0.1, -0.2],
      support: {
        logprobs: "returned",
        tokenIds: "returned",
      },
    });
    expect(completion.samplingTrace?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

function actionBindings(
  agentRelease: HarnessActionBinding["agentRelease"],
): HarnessActionBinding[] {
  const snapshotSchema = {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
  };
  const decisionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      allocations: { type: "array" },
      rationale: { type: "string" },
      riskControls: { type: "array" },
    },
    required: ["allocations", "rationale", "riskControls"],
  };
  return [
    {
      schemaVersion: "openpond.harnessActionBinding.v1",
      actionId: "get-portfolio-snapshot",
      modelToolName: "get_portfolio_snapshot",
      description: "Get the private episode's visible portfolio snapshot.",
      inputSchema: snapshotSchema,
      actionSchemaHash: contentHash(snapshotSchema),
      agentRelease,
      implementationHash: sha256("snapshot-implementation"),
      runtimeBindingId: "snapshot-runtime",
      capabilityReceiptHash: sha256("snapshot-capability"),
      sideEffect: "read",
      studentVisible: true,
      timeoutMs: 30_000,
      episodeArgumentBindings: [{
        argument: "scenarioId",
        source: "case_id",
      }],
    },
    {
      schemaVersion: "openpond.harnessActionBinding.v1",
      actionId: "submit-budget-decision",
      modelToolName: "submit_budget_decision",
      description: "Submit a complete portfolio budget decision.",
      inputSchema: decisionSchema,
      actionSchemaHash: contentHash(decisionSchema),
      agentRelease,
      implementationHash: sha256("decision-implementation"),
      runtimeBindingId: "decision-runtime",
      capabilityReceiptHash: sha256("decision-capability"),
      sideEffect: "write",
      studentVisible: true,
      timeoutMs: 30_000,
      episodeArgumentBindings: [{
        argument: "scenarioId",
        source: "case_id",
      }],
    },
  ];
}

function manifest(
  projection: HarnessBundleProjection,
  actionBindings: HarnessActionBinding[],
): HarnessExecutionBundleManifest {
  const content = {
    schemaVersion: "openpond.harnessExecutionBundle.v1" as const,
    harnessRelease: {
      id: "harness_test",
      contentHash: sha256("harness"),
    },
    resolvedGraphHash: sha256("graph"),
    target: {
      adapterId: "local-harness",
      projection,
      runtimeVersion: "1",
    },
    files: [],
    actionBindings,
    secretDeclarations: [],
  };
  return {
    ...content,
    contentHash: contentHash(content),
  };
}
