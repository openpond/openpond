import { randomUUID } from "node:crypto";

import { goalIterationBudgetRemaining } from "./budgets";
import { createGoalEvent, recordGoalEvent } from "./events";
import {
  buildGoalLlmMessages,
  callHostedGoalLlm,
  callLocalGoalLlm,
} from "./llm";
import {
  runLocalCreatePipeline,
  shouldRunLocalCreatePipeline,
} from "./local-create-pipeline";
import { assertGoalCanStartIteration } from "./policy";
import { getGoalProfileDescriptor } from "./profiles";
import { createGoalRunResult } from "./result";
import type {
  GoalLlmResponse,
  GoalRunConfig,
  GoalRunResult,
  GoalStatus,
} from "./types";
import type { GoalStateAdapter } from "./state/adapter";
import { HostedGoalClient } from "./state/hosted";
import { runGoalVerificationChecks } from "./tools/checks";
import { buildGoalLlmToolSchemas } from "./tools/registry";
import {
  runGoalLlmToolCall,
  type GoalToolExecutionResult,
} from "./tools/dispatch";

const MAX_GOAL_TOOL_ROUNDS = 24;

export async function runGoalIteration(params: {
  config: GoalRunConfig;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<GoalRunResult> {
  assertGoalCanStartIteration(params.config.goal);

  if (goalIterationBudgetRemaining(params.config.goal) <= 0) {
    const limited = createGoalEvent({
      goalId: params.config.goal.id,
      kind: "goal.blocked",
      summary: "Goal iteration budget exhausted",
      payload: {
        reason: "iteration_budget_exhausted",
        maxIterations: params.config.goal.budget.maxIterations,
      },
    });
    await recordGoalEvent(limited, params);
    await updateGoalStatus(params, "budget_limited");
    return finishGoalRunResult(
      params,
      createGoalRunResult({
        goal: params.config.goal,
        status: "budget_limited",
        summary: limited.summary,
        events: [limited],
      })
    );
  }

  const iterationId = params.config.iterationId || `iteration_${randomUUID()}`;
  const started = createGoalEvent({
    goalId: params.config.goal.id,
    iterationId,
    kind: "iteration.started",
    summary: "Goal iteration started",
    payload: {
      mode: params.config.mode,
      profile: params.config.goal.profile,
      promptPack: params.config.goal.promptPack,
    },
  });
  await updateGoalStatus(params, "running");
  await recordGoalEvent(started, params);

  const events = [started];
  const profile = getGoalProfileDescriptor(params.config.goal);
  const workspace = params.config.workspace ?? process.cwd();
  const storageRoot = params.config.storageRoot ?? workspace;

  if (shouldRunLocalCreatePipeline(params.config.goal, params.config.mode)) {
    const result = await runLocalCreatePipeline({
      goal: params.config.goal,
      iterationId,
      workspace,
      localState: params.localState,
      startedEvents: events,
    });
    return finishGoalRunResult(params, result);
  }

  let llmResponse: GoalLlmResponse | null = null;
  let toolResults: GoalToolExecutionResult[] = [];

  const toolSchemas = buildGoalLlmToolSchemas(profile.toolNames);
  try {
    const planner = await runGoalPlannerLoop({
      ...params,
      iterationId,
      workspace,
      storageRoot,
      toolSchemas,
      profileMetadata: { profile: profile.id, tools: profile.toolNames },
    });
    llmResponse = planner.response;
    toolResults = planner.toolResults;
  } catch (error) {
    const blocked = createGoalEvent({
      goalId: params.config.goal.id,
      iterationId,
      kind: "goal.blocked",
      summary:
        params.config.mode === "hosted"
          ? "Hosted Goal LLM route is not available"
          : "Local Goal LLM route is not available",
      payload: {
        error: error instanceof Error ? error.message : "LLM route failed",
      },
    });
    await recordGoalEvent(blocked, params);
    await updateGoalStatus(params, "blocked");
    return finishGoalRunResult(
      params,
      createGoalRunResult({
        goal: params.config.goal,
        status: "blocked",
        summary: blocked.summary,
        events: [...events, blocked],
      })
    );
  }

  if (llmResponse) {
    const pausedForQuestion = toolResults.find(
      (result) => result.status === "needs_user_input"
    );
    if (pausedForQuestion) {
      const paused = createGoalEvent({
        goalId: params.config.goal.id,
        iterationId,
        kind: "iteration.completed",
        summary: pausedForQuestion.summary,
        payload: {
          status: "awaiting_user_input",
          toolResults: compactToolResults(toolResults),
        },
      });
      await recordGoalEvent(paused, params);
      await updateGoalStatus(params, "awaiting_user_input");
      return finishGoalRunResult(
        params,
        createGoalRunResult({
          goal: params.config.goal,
          status: "awaiting_user_input",
          summary: paused.summary,
          events: [...events, paused],
        })
      );
    }

    const pausedForApproval = toolResults.find(
      (result) => result.status === "needs_approval"
    );
    if (pausedForApproval) {
      const paused = createGoalEvent({
        goalId: params.config.goal.id,
        iterationId,
        kind: "iteration.completed",
        summary: pausedForApproval.summary,
        payload: {
          status: "awaiting_approval",
          toolResults: compactToolResults(toolResults),
        },
      });
      await recordGoalEvent(paused, params);
      await updateGoalStatus(params, "awaiting_approval");
      return finishGoalRunResult(
        params,
        createGoalRunResult({
          goal: params.config.goal,
          status: "awaiting_approval",
          summary: paused.summary,
          events: [...events, paused],
        })
      );
    }

    const blockedTool = latestUnresolvedBlockedToolResult(toolResults);
    if (blockedTool) {
      const blocked = createGoalEvent({
        goalId: params.config.goal.id,
        iterationId,
        kind: "goal.blocked",
        summary: blockedTool.summary,
        payload: {
          toolResults: compactToolResults(toolResults),
        },
      });
      await recordGoalEvent(blocked, params);
      await updateGoalStatus(params, "blocked");
      return finishGoalRunResult(
        params,
        createGoalRunResult({
          goal: params.config.goal,
          status: "blocked",
          summary: blocked.summary,
          events: [...events, blocked],
        })
      );
    }

    if (
      llmResponse.status === "needs_user_input" &&
      (llmResponse.toolCalls?.length ?? 0) === 0
    ) {
      const blocked = createGoalEvent({
        goalId: params.config.goal.id,
        iterationId,
        kind: "goal.blocked",
        summary: "Goal needs user input but no structured question was provided",
        payload: {
          responseSummary: llmResponse.summary ?? null,
        },
      });
      await recordGoalEvent(blocked, params);
      await updateGoalStatus(params, "blocked");
      return finishGoalRunResult(
        params,
        createGoalRunResult({
          goal: params.config.goal,
          status: "blocked",
          summary: blocked.summary,
          events: [...events, blocked],
        })
      );
    }

    if (
      llmResponse.status === "blocked" &&
      (llmResponse.toolCalls?.length ?? 0) === 0
    ) {
      const blocked = createGoalEvent({
        goalId: params.config.goal.id,
        iterationId,
        kind: "goal.blocked",
        summary: llmResponse.summary || "Goal LLM reported a blocker",
        payload: {
          message: llmResponse.message?.content ?? null,
        },
      });
      await recordGoalEvent(blocked, params);
      await updateGoalStatus(params, "blocked");
      return finishGoalRunResult(
        params,
        createGoalRunResult({
          goal: params.config.goal,
          status: "blocked",
          summary: blocked.summary,
          events: [...events, blocked],
        })
      );
    }
  }

  if (params.config.goal.verification.commands.length > 0) {
    const checks = await runGoalVerificationChecks({
      goal: params.config.goal,
      iterationId,
      cwd: workspace,
      workspace,
      storageRoot,
      localState: params.localState,
      hostedClient: params.hostedClient,
    });
    const failed = checks.find((check) => check.status !== "passed");
    const completed = createGoalEvent({
      goalId: params.config.goal.id,
      iterationId,
      kind: "iteration.completed",
      summary: failed
        ? "Goal iteration completed with failed checks"
        : "Goal verification checks passed",
      payload: {
        checks: checks.map((check) => ({
          id: check.id,
          name: check.name,
          status: check.status,
          code: check.code,
        })),
      },
    });
    await recordGoalEvent(completed, params);
    await updateGoalStatus(params, failed ? "blocked" : "completed");
    return finishGoalRunResult(
      params,
      createGoalRunResult({
        goal: params.config.goal,
        status: failed ? "blocked" : "completed",
        summary: completed.summary,
        events: [...events, completed],
      })
    );
  }

  if (toolResults.length > 0) {
    const completed = createGoalEvent({
      goalId: params.config.goal.id,
      iterationId,
      kind: "iteration.completed",
      summary: llmResponse?.summary || "Goal tool calls completed",
      payload: {
        toolResults: compactToolResults(toolResults),
        verificationConfigured: false,
      },
    });
    await recordGoalEvent(completed, params);
    await updateGoalStatus(params, "completed");
    return finishGoalRunResult(
      params,
      createGoalRunResult({
        goal: params.config.goal,
        status: "completed",
        summary: completed.summary,
        events: [...events, completed],
      })
    );
  }

  const blocked = createGoalEvent({
    goalId: params.config.goal.id,
    iterationId,
    kind: "goal.blocked",
    summary: "Goal produced no tool calls or verification commands",
    payload: {
      reason: "no_executable_goal_plan",
      profile: profile.id,
      next: "configure a hosted Goal LLM route, local provider, tool calls, or verification commands",
    },
  });
  await recordGoalEvent(blocked, params);
  await updateGoalStatus(params, "blocked");

  return finishGoalRunResult(
    params,
    createGoalRunResult({
      goal: params.config.goal,
      status: "blocked",
      summary: blocked.summary,
      events: [started, blocked],
    })
  );
}

async function runGoalPlannerLoop(params: {
  config: GoalRunConfig;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
  iterationId: string;
  workspace: string;
  storageRoot: string;
  toolSchemas: Array<Record<string, unknown>>;
  profileMetadata: Record<string, unknown>;
}): Promise<{
  response: GoalLlmResponse | null;
  toolResults: GoalToolExecutionResult[];
}> {
  if (params.config.mode === "hosted" && !params.hostedClient) {
    return { response: null, toolResults: [] };
  }

  const messages = buildGoalLlmMessages(params.config.goal);
  const toolResults: GoalToolExecutionResult[] = [];
  let response: GoalLlmResponse | null = null;

  for (let round = 0; round < MAX_GOAL_TOOL_ROUNDS; round += 1) {
    response =
      params.config.mode === "hosted"
        ? await callHostedGoalLlm({
            goal: params.config.goal,
            iterationId: params.iterationId,
            hostedClient: params.hostedClient as HostedGoalClient,
            localState: params.localState,
            messages,
            tools: params.toolSchemas,
            metadata: { ...params.profileMetadata, round },
          })
        : await callLocalGoalLlm({
            goal: params.config.goal,
            iterationId: params.iterationId,
            localState: params.localState,
            messages,
            tools: params.toolSchemas,
            metadata: { ...params.profileMetadata, round },
          });
    if (!response) return { response: null, toolResults };

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) return { response, toolResults };

    const roundResults = await runLlmToolCalls({
      config: params.config,
      localState: params.localState,
      hostedClient: params.hostedClient,
      iterationId: params.iterationId,
      workspace: params.workspace,
      storageRoot: params.storageRoot,
      response,
    });
    toolResults.push(...roundResults);
    messages.push(assistantToolCallMessage(response));
    messages.push(...roundResults.map(toolResultMessage));
    if (
      roundResults.some(
        (result) =>
          result.status === "needs_user_input" ||
          result.status === "needs_approval"
      )
    ) {
      return { response, toolResults };
    }
  }

  return {
    response: {
      status: "blocked",
      summary: "Goal planner exceeded tool round budget",
      message: {
        role: "assistant",
        content: "Goal planner exceeded tool round budget.",
      },
    },
    toolResults,
  };
}

function latestUnresolvedBlockedToolResult(
  results: GoalToolExecutionResult[]
): GoalToolExecutionResult | null {
  const latest = results.at(-1);
  return latest?.status === "blocked" ? latest : null;
}

async function runLlmToolCalls(params: {
  config: GoalRunConfig;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
  iterationId: string;
  workspace: string;
  storageRoot: string;
  response: GoalLlmResponse;
}): Promise<GoalToolExecutionResult[]> {
  const toolCalls = params.response.toolCalls ?? [];
  const results: GoalToolExecutionResult[] = [];
  for (const toolCall of toolCalls) {
    const result = await runGoalLlmToolCall(
      {
        goal: params.config.goal,
        iterationId: params.iterationId,
        workspace: params.workspace,
        storageRoot: params.storageRoot,
        localState: params.localState,
        hostedClient: params.hostedClient,
      },
      toolCall
    );
    results.push(result);
    if (result.status !== "ok") break;
  }
  return results;
}

function assistantToolCallMessage(response: GoalLlmResponse) {
  return {
    role: "assistant" as const,
    content: response.message?.content ?? response.summary ?? "",
    tool_calls: (response.toolCalls ?? []).map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    })),
  };
}

function toolResultMessage(result: GoalToolExecutionResult) {
  return {
    role: "tool" as const,
    tool_call_id: result.toolCallId,
    name: result.name,
    content: JSON.stringify({
      status: result.status,
      summary: result.summary,
      output: result.output ?? {},
      checksPassed: result.checksPassed ?? null,
    }),
  };
}

function compactToolResults(
  results: GoalToolExecutionResult[]
): Array<Record<string, unknown>> {
  return results.map((result) => ({
    toolCallId: result.toolCallId,
    name: result.name,
    status: result.status,
    summary: result.summary,
    checksPassed: result.checksPassed,
  }));
}

async function finishGoalRunResult(
  params: {
    config: GoalRunConfig;
    localState?: GoalStateAdapter | null;
  },
  result: GoalRunResult
): Promise<GoalRunResult> {
  if (!params.localState?.writeResult) return result;
  const current = await params.localState.get(params.config.goal.id);
  const persisted = current ? { ...result, events: current.events } : result;
  await params.localState.writeResult(params.config.goal.id, persisted);
  return persisted;
}

async function updateGoalStatus(
  params: {
    config: GoalRunConfig;
    localState?: GoalStateAdapter | null;
    hostedClient?: HostedGoalClient | null;
  },
  status: GoalStatus
): Promise<void> {
  await params.hostedClient?.updateStatus(params.config.goal.id, status);
  if (params.localState) {
    const current = await params.localState.get(params.config.goal.id);
    await params.localState.update({
      ...(current ?? params.config.goal),
      status,
      updatedAt: new Date().toISOString(),
    });
  }
}
