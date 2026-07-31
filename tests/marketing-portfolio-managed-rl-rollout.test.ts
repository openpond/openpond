import { describe, expect, test, vi } from "vitest";

import type { TaskDataRecord, Taskset } from "@openpond/contracts";

import { runMarketingPortfolioRollout } from "../apps/server/src/training/marketing-portfolio-rollout.js";
import type { ProfileAgentHarnessRuntime } from "../apps/server/src/training/profile-agent-harness-runtime.js";

describe("marketing portfolio Managed RL rollout", () => {
  test("runs ordered tools, repairs a public constraint failure, and keeps the case private", async () => {
    const policyMessages: unknown[] = [];
    const policyToolCatalogs: string[][] = [];
    const policyToolSchemas: Array<Record<string, unknown>> = [];
    const requiredToolNames: string[] = [];
    const executedDecisions: Array<Record<string, unknown>> = [];
    const executeAction = vi.fn(
      async (input: {
        binding: { actionId: string };
        arguments: Record<string, unknown>;
      }) => {
        expect(input.arguments.scenarioId).toBe("case-private-1");
        if (input.binding.actionId === "get-portfolio-snapshot") {
          return {
            output: {
              scenarioId: "case-private-1",
              incrementalBudgetUsd: 1_000,
              allocationIncrementUsd: 50,
              channelLimits: [
                {
                  channelId: "paid_search",
                  minimumUsd: 200,
                  maximumUsd: 500,
                },
                {
                  channelId: "paid_social",
                  minimumUsd: 150,
                  maximumUsd: 400,
                },
                {
                  channelId: "streaming_video",
                  minimumUsd: 100,
                  maximumUsd: 350,
                },
                {
                  channelId: "lifecycle",
                  minimumUsd: 50,
                  maximumUsd: 250,
                },
              ],
            },
            artifactRefs: [],
            terminal: false,
          };
        }
        executedDecisions.push(structuredClone(input.arguments));
        const allocations = input.arguments.allocations as Array<{
          amountUsd: number;
        }>;
        const accepted =
          allocations.reduce((total, item) => total + item.amountUsd, 0) ===
          1_000;
        return {
          output: accepted
            ? { accepted: true }
            : {
                accepted: false,
                errors: ["Allocations must total the incremental budget."],
              },
          artifactRefs: [],
          terminal: accepted,
        };
      },
    );
    const runtime = {
      executeAction,
      scoreDecision: vi.fn(async () => ({
        reward: 0.73,
        components: {
          constraints: 1,
          portfolioValue: 0.72,
          riskControls: 0.65,
          rationale: 0.55,
        },
        validation: { accepted: true },
      })),
    } as unknown as ProfileAgentHarnessRuntime;
    const invalidDecision = {
      allocations: [
        { channelId: "paid_search", amountUsd: 400 },
        { channelId: "paid_social", amountUsd: 250 },
        { channelId: "streaming_video", amountUsd: 150 },
        { channelId: "lifecycle", amountUsd: 100 },
      ],
      rationale: "Prefer channels with near-term evidence.",
      riskControls: ["weekly pacing review"],
    };
    const policyResult = {
      servedPolicyVersion: 0,
      trainingSample: {
        schemaVersion: "openpond.managedRlTrainingSample.v1",
        modelRequestId: "request-final",
      },
    };
    const result = await runMarketingPortfolioRollout({
      taskset: marketingTaskset(),
      task: marketingTask(),
      runtime,
      policy: {
        complete: vi.fn(
          async ({ turnIndex, messages, tools, requiredToolName }) => {
            policyMessages.push(structuredClone(messages));
            policyToolCatalogs.push(tools.map((tool) => tool.function.name));
            policyToolSchemas.push(
              ...tools.map((tool) =>
                structuredClone(tool.function.parameters),
              ),
            );
            requiredToolNames.push(requiredToolName);
            return {
              content: null,
              toolCalls: [
                {
                  id: `call-${turnIndex}`,
                  name: requiredToolName,
                  arguments:
                    requiredToolName === "get_portfolio_snapshot"
                      ? "{}"
                      : JSON.stringify(invalidDecision),
                },
              ],
              policyResult,
            };
          },
        ),
      },
    });

    expect(result).toMatchObject({
      reward: 0.73,
      components: {
        constraints: 1,
        portfolioValue: 0.72,
        riskControls: 0.65,
        rationale: 0.55,
      },
      terminal: true,
      toolSequence: [
        "get_portfolio_snapshot",
        "submit_budget_decision",
        "submit_budget_decision",
      ],
      policyResult,
    });
    expect(executedDecisions).toHaveLength(2);
    expect(
      (
        executedDecisions[1]!.allocations as Array<{ amountUsd: number }>
      ).reduce((total, item) => total + item.amountUsd, 0),
    ).toBe(1_000);
    expect(JSON.stringify(policyMessages)).not.toContain("case-private-1");
    expect(JSON.stringify(policyMessages)).toContain(
      "Use this deterministic projection",
    );
    expect(policyToolCatalogs).toEqual([
      ["get_portfolio_snapshot"],
      ["get_portfolio_snapshot", "submit_budget_decision"],
      ["get_portfolio_snapshot", "submit_budget_decision"],
    ]);
    expect(requiredToolNames).toEqual([
      "get_portfolio_snapshot",
      "submit_budget_decision",
      "submit_budget_decision",
    ]);
    expect(JSON.stringify(policyToolSchemas)).not.toContain("uniqueItems");
    expect(
      JSON.stringify(
        marketingTaskset().environment.actionBindings?.[1]?.inputSchema,
      ),
    ).toContain('"uniqueItems":true');
  });
});

function marketingTaskset(): Taskset {
  const common = {
    agentRelease: {
      id: "agent-marketing-portfolio-manager",
      revision: 1,
      contentHash: "a".repeat(64),
    },
    actionSchemaHash: "b".repeat(64),
    implementationHash: "c".repeat(64),
    description: "Marketing portfolio action",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    episodeArgumentBindings: [
      {
        argument: "scenarioId",
        source: "task.metadata.caseId",
      },
    ],
    studentVisible: true,
    timeoutMs: 1_000,
  };
  return {
    environment: {
      actionBindings: [
        {
          ...common,
          actionId: "get-portfolio-snapshot",
          modelToolName: "get_portfolio_snapshot",
        },
        {
          ...common,
          actionId: "submit-budget-decision",
          modelToolName: "submit_budget_decision",
          inputSchema: {
            type: "object",
            properties: {
              riskControls: {
                type: "array",
                uniqueItems: true,
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        },
      ],
    },
  } as unknown as Taskset;
}

function marketingTask(): TaskDataRecord {
  return {
    id: "marketing-case-1",
    input: {
      prompt:
        "Allocate the incremental marketing budget using the available portfolio tools.",
    },
    metadata: {
      caseId: "case-private-1",
    },
  } as unknown as TaskDataRecord;
}
