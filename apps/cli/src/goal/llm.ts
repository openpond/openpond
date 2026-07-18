import {
  resolveOpChatApiBaseUrl,
  sendHostedChatTurn,
  type HostedChatCompletion,
  type HostedChatTool,
} from "../hosted-chat";
import { createGoalEvent, recordGoalEvent } from "./events";
import { resolveGoalPromptPack } from "./prompts";
import { redactJson } from "./redaction";
import type { HostedGoalClient } from "./state/hosted";
import type { GoalStateAdapter } from "./state/adapter";
import type {
  GoalLlmMessage,
  GoalLlmRequest,
  GoalLlmResponse,
  GoalState,
} from "./types";

export function buildGoalLlmMessages(goal: GoalState): GoalLlmMessage[] {
  const promptPack = resolveGoalPromptPack(goal);
  return [
    {
      role: "system",
      content: [
        "You are the OpenPond Goal runner. Produce executable tool calls, ask structured questions when blocked, and stay within the provided execution policy.",
        "",
        promptPack.instructions,
        "",
        "Runner rules:",
        "- Use files_write for source edits instead of describing edits.",
        "- Use questions_ask for required user input.",
        "- Use checks_run or configured verification commands before claiming completion.",
        "- Hosted coding sandboxes include node, npm, pnpm, and common POSIX utilities; follow the target repository's lockfile when choosing install/test commands, use command -v for PATH checks, and do not block on standalone toolchain probes once a needed package manager command works.",
        "- For OpenPond agent goals, run SDK actions through openpond_agent_* tools. Do not invoke openpond-agent through shell, npx, pnpm dlx, or yarn dlx.",
        "- For OpenPond agent goals, after source edits use openpond_agent_default_checks unless a narrower SDK command is clearly enough; do not spend the remaining rounds on broad inspection.",
        "- After required edits and checks are complete, return a concise final response with no tool calls.",
        "- Do not keep inspecting once you have enough context to make the requested change.",
        "- Do not claim external integration reads or writes succeeded without tool evidence.",
      ].join("\n"),
    },
    {
      role: "user",
      content: buildGoalUserContext(goal),
    },
  ];
}

function buildGoalUserContext(goal: GoalState): string {
  const answeredQuestions = goal.questions
    .filter((question) => question.answeredAt)
    .map((question) => {
      const answer = goal.answers.find((item) => item.questionId === question.id);
      return {
        question: question.title,
        optionId: answer?.optionId ?? null,
        answer: answer?.freeformText ?? null,
        value: answer?.value ?? {},
      };
    });
  const openQuestions = goal.questions
    .filter((question) => !question.answeredAt)
    .map((question) => ({
      title: question.title,
      reason: question.reason,
      required: question.required,
      options: question.options,
      freeformAllowed: question.freeformAllowed,
    }));
  const approvals = goal.approvals.map((approval) => ({
    kind: approval.kind,
    status: approval.status,
    title: approval.title,
    reason: approval.reason,
    decisionNote: approval.decisionNote,
    decidedAt: approval.decidedAt,
  }));
  const createImproveRun = goal.createImproveRun
    ? {
        id: goal.createImproveRun.id,
        state: goal.createImproveRun.state,
        operation: goal.createImproveRun.operation,
        surface: goal.createImproveRun.surface,
        command: goal.createImproveRun.command,
        sourceAuthority: goal.createImproveRun.adapter.sourceAuthority,
        confirmationPolicy: goal.createImproveRun.adapter.confirmationPolicy,
        plan: goal.createImproveRun.plan
          ? {
              id: goal.createImproveRun.plan.id,
              status: goal.createImproveRun.plan.status,
              summary: goal.createImproveRun.plan.summary,
              defaultChatAction: goal.createImproveRun.plan.defaultChatAction,
              sourcePlan: goal.createImproveRun.plan.sourcePlan,
              requirements: goal.createImproveRun.plan.requirements,
              checks: goal.createImproveRun.plan.checks,
              metadata: {
                actionShape:
                  goal.createImproveRun.plan.metadata?.actionShape ?? null,
                actionShapeDecisionSource:
                  goal.createImproveRun.plan.metadata?.actionShapeDecisionSource ?? null,
              },
              approvedAt: goal.createImproveRun.plan.approvedAt,
            }
          : null,
        workflowCapture: goal.createImproveRun.workflowCapture
          ? {
              id: goal.createImproveRun.workflowCapture.id,
              tools: goal.createImproveRun.workflowCapture.tools,
              apps: goal.createImproveRun.workflowCapture.apps,
              targetRepoAssumptions:
                goal.createImproveRun.workflowCapture.targetRepoAssumptions,
            }
          : null,
      }
    : null;
  return [
    `Objective: ${goal.objective}`,
    "",
    "Goal metadata:",
    JSON.stringify(
      {
        goalId: goal.id,
        kind: goal.kind,
        profile: goal.profile,
        promptPack: goal.promptPack,
        status: goal.status,
        constraints: goal.constraints,
        evidenceRefs: goal.evidenceRefs,
        executionPolicy: goal.executionPolicy,
        verification: goal.verification,
        createImproveRun,
        answeredQuestions,
        openQuestions,
        approvals,
      },
      null,
      2
    ),
  ].join("\n");
}

export async function callHostedGoalLlm(params: {
  goal: GoalState;
  iterationId: string;
  hostedClient: HostedGoalClient;
  localState?: GoalStateAdapter | null;
  messages?: GoalLlmMessage[];
  tools?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}): Promise<GoalLlmResponse> {
  const request: GoalLlmRequest = {
    goalId: params.goal.id,
    iterationId: params.iterationId,
    promptPack: params.goal.promptPack,
    messages: params.messages ?? buildGoalLlmMessages(params.goal),
    tools: params.tools,
    metadata: params.metadata,
  };
  const response = await params.hostedClient.callLlm(request);
  if (response.usage) {
    await recordGoalEvent(
      createGoalEvent({
        goalId: params.goal.id,
        iterationId: params.iterationId,
        kind: "model.usage",
        summary: "Goal LLM call completed",
        payload: redactJson({ usage: response.usage }) as Record<string, unknown>,
      }),
      { localState: params.localState, hostedClient: params.hostedClient }
    );
  }
  return response;
}

export function resolveLocalGoalLlmConfig(
  env: Record<string, string | undefined> =
    typeof process === "undefined" ? {} : process.env
): { apiBaseUrl: string; token: string; model: string } | null {
  const token =
    env.OPENPOND_GOAL_OPCHAT_API_KEY?.trim() ||
    env.OPENPOND_OPCHAT_API_KEY?.trim() ||
    env.OPENPOND_API_KEY?.trim();
  if (!token) return null;
  return {
    apiBaseUrl: resolveOpChatApiBaseUrl({ env }),
    token,
    model:
      env.OPENPOND_GOAL_MODEL?.trim() ||
      env.OPENPOND_OPCHAT_MODEL?.trim() ||
      "openpond-chat",
  };
}

export async function callLocalGoalLlm(params: {
  goal: GoalState;
  iterationId: string;
  localState?: GoalStateAdapter | null;
  messages?: GoalLlmMessage[];
  tools?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}): Promise<GoalLlmResponse | null> {
  const config = resolveLocalGoalLlmConfig(params.env);
  if (!config) return null;
  const completion = await sendHostedChatTurn({
    apiBaseUrl: config.apiBaseUrl,
    token: config.token,
    model: config.model,
    messages: params.messages ?? buildGoalLlmMessages(params.goal),
    tools: params.tools as HostedChatTool[] | undefined,
    toolChoice: params.tools?.length ? "auto" : undefined,
    temperature: 0.2,
    metadata: {
      source: "openpond-code-goal",
      goalId: params.goal.id,
      promptPack: params.goal.promptPack,
      ...(params.metadata ?? {}),
    },
  });
  const response = goalLlmResponseFromHostedChatCompletion(completion, {
    afterToolResults: (params.messages ?? []).some(
      (message) => message.role === "tool"
    ),
  });
  if (response.usage) {
    await recordGoalEvent(
      createGoalEvent({
        goalId: params.goal.id,
        iterationId: params.iterationId,
        kind: "model.usage",
        summary: "Local Goal LLM call completed",
        payload: redactJson({ usage: response.usage }) as Record<string, unknown>,
      }),
      { localState: params.localState }
    );
  }
  return response;
}

function goalLlmResponseFromHostedChatCompletion(
  completion: HostedChatCompletion,
  options: { afterToolResults?: boolean } = {}
): GoalLlmResponse {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  const content =
    typeof message?.content === "string" ? message.content.trim() : "";
  const toolCalls = (message?.tool_calls ?? []).flatMap((toolCall) => {
    const id = typeof toolCall.id === "string" ? toolCall.id : "";
    const name =
      typeof toolCall.function?.name === "string" ? toolCall.function.name : "";
    if (!id || !name) return [];
    return [
      {
        id,
        name,
        arguments: parseToolArguments(toolCall.function?.arguments),
      },
    ];
  });
  return {
    status: toolCalls.length > 0 || options.afterToolResults ? "ok" : "blocked",
    summary:
      toolCalls.length > 0
        ? `Goal planner returned ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}.`
        : content || "Goal planner returned no executable tool calls.",
    message: {
      role: "assistant",
      content,
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(completion.usage
      ? {
          usage: {
            inputTokens:
              completion.usage.prompt_tokens ?? completion.usage.input_tokens,
            outputTokens:
              completion.usage.completion_tokens ??
              completion.usage.output_tokens,
            totalTokens: completion.usage.total_tokens,
          },
        }
      : {}),
  };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
