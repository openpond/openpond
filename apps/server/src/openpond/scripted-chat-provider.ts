import type { HostedChatMessage, HostedChatToolCall } from "@openpond/cloud";
import type { HostedChatTurnDelta, HostedChatTurnInput } from "@openpond/runtime";

export const OPENPOND_SCRIPTED_MODEL_PREFIX = "openpond-scripted-";
export const OPENPOND_HARNESS_SCRIPTED_MODELS_ENV = "OPENPOND_HARNESS_SCRIPTED_MODELS";
export const OPENPOND_SCRIPTED_CHAT_TWO_TURNS_MODEL = "openpond-scripted-chat-two-turns";
export const OPENPOND_SCRIPTED_SUBAGENT_LIFECYCLE_MODEL = "openpond-scripted-subagent-lifecycle";
export const OPENPOND_SCRIPTED_SUBAGENT_RUNNING_MODEL = "openpond-scripted-subagent-running-delay";
export const OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL = "openpond-scripted-goal-subagent-running";
export const OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL = "openpond-scripted-subagent-handoff";
export const OPENPOND_SCRIPTED_SUBAGENT_CANCEL_MODEL = "openpond-scripted-subagent-cancel";
export const OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL = "openpond-scripted-subagent-blocker";

const SCRIPTED_SUBAGENT_RUNNING_DELAY_MS = 8_000;
const SCRIPTED_GOAL_PARENT_RUNNING_DELAY_MS = 12_000;

type StreamOpenPondHostedChatTurn = (
  input: HostedChatTurnInput,
) => AsyncGenerator<HostedChatTurnDelta, void, unknown>;

export function scriptedOpenPondModelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isScriptedOpenPondModel(model: string | null | undefined): boolean {
  return Boolean(model?.startsWith(OPENPOND_SCRIPTED_MODEL_PREFIX));
}

export function createScriptedOpenPondChatStream(
  fallback: StreamOpenPondHostedChatTurn,
  options: { enabled?: boolean } = {},
): StreamOpenPondHostedChatTurn {
  return async function* scriptedOpenPondChatStream(input) {
    if (!options.enabled || !isScriptedOpenPondModel(input.model)) {
      yield* fallback(input);
      return;
    }
    yield* streamScriptedOpenPondChatTurn(input);
  };
}

export async function* streamScriptedOpenPondChatTurn(
  input: HostedChatTurnInput,
): AsyncGenerator<HostedChatTurnDelta, void, unknown> {
  const model = input.model ?? "";
  if (
    model === OPENPOND_SCRIPTED_SUBAGENT_LIFECYCLE_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_RUNNING_MODEL ||
    model === OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_CANCEL_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL
  ) {
    yield* streamSubagentLifecycle(input);
    return;
  }
  if (model === OPENPOND_SCRIPTED_CHAT_TWO_TURNS_MODEL) {
    yield* streamTwoTurnChat(input);
    return;
  }
  yield textDelta(`Scripted OpenPond model ${model || "(missing model)"} completed.`);
  yield finishDelta("stop");
}

function* streamTwoTurnChat(input: HostedChatTurnInput): Generator<HostedChatTurnDelta, void, unknown> {
  const userTurns = input.messages.filter((message) => message.role === "user").length;
  const latest = latestUserText(input.messages);
  yield textDelta(`scripted turn ${Math.max(1, userTurns)} response`);
  if (latest) yield textDelta(` for: ${latest.slice(0, 80)}`);
  yield finishDelta("stop");
}

async function* streamSubagentLifecycle(input: HostedChatTurnInput): AsyncGenerator<HostedChatTurnDelta, void, unknown> {
  const model = input.model ?? "";
  const toolNames = new Set((input.tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
  if (isScriptedSubagentChildTurn(input.messages) || !toolNames.has("openpond_subagent_start")) {
    yield* streamScriptedChildSubagent(input, toolNames);
    return;
  }

  const parentWakeRunId = model === OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL
    ? scriptedParentWakeRunId(input.messages)
    : null;
  const startResult = latestToolResult(input.messages, "openpond_subagent_start");
  const latestResult = latestSubagentInspection(input.messages);
  if (!startResult && parentWakeRunId && !latestResult && toolNames.has("openpond_subagent_join")) {
    yield toolCallDelta("openpond_subagent_join", { runId: parentWakeRunId });
    yield finishDelta("tool_calls");
    return;
  }
  if (!startResult && !parentWakeRunId) {
    yield toolCallDelta("openpond_subagent_start", {
      roleId: scriptedSubagentRoleId(model),
      objective: scriptedSubagentObjective(model),
      context: "This is a deterministic desktop harness proof run. Do not edit files.",
      required: true,
    });
    yield finishDelta("tool_calls");
    return;
  }

  const runId = subagentRunIdFromResult(startResult) ?? parentWakeRunId ?? "unknown-run";
  if (model === OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL && latestResult === null) {
    await delay(SCRIPTED_GOAL_PARENT_RUNNING_DELAY_MS);
    yield textDelta(`Goal-scoped research subagent stayed visible while running for ${runId}.`);
    yield finishDelta("stop");
    return;
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_CANCEL_MODEL) {
    yield* streamSubagentCancellation(input, toolNames, runId);
    return;
  }
  if (
    model === OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL &&
    !isScriptedParentWakeTurn(input.messages) &&
    latestResult === null
  ) {
    yield textDelta(`Research subagent handoff child started for ${runId}.`);
    yield finishDelta("stop");
    return;
  }

  const latestStatus = subagentStatusFromResult(latestResult) ?? subagentStatusFromResult(startResult);
  if (latestStatus === "completed") {
    yield textDelta(`Research subagent lifecycle complete for ${runId}.`);
    yield finishDelta("stop");
    return;
  }
  if (latestStatus === "blocked" || latestStatus === "failed" || latestStatus === "cancelled") {
    yield textDelta(`${scriptedSubagentRoleLabel(model)} subagent ${latestStatus} for ${runId}.`);
    yield finishDelta("stop");
    return;
  }

  if (toolNames.has("openpond_subagent_join") && toolResultCount(input.messages, "openpond_subagent_join") === 0) {
    yield toolCallDelta("openpond_subagent_join", { runId });
    yield finishDelta("tool_calls");
    return;
  }

  if (toolNames.has("openpond_subagent_status") && toolResultCount(input.messages, "openpond_subagent_status") < 3) {
    yield toolCallDelta("openpond_subagent_status", { runId });
    yield finishDelta("tool_calls");
    return;
  }

  if (toolNames.has("openpond_subagent_join") && toolResultCount(input.messages, "openpond_subagent_join") < 4) {
    yield toolCallDelta("openpond_subagent_join", { runId });
    yield finishDelta("tool_calls");
    return;
  }

  yield textDelta(`Research subagent lifecycle is still ${latestStatus ?? "pending"} for ${runId}.`);
  yield finishDelta("stop");
}

async function* streamScriptedChildSubagent(
  input: HostedChatTurnInput,
  toolNames: Set<string | undefined>,
): AsyncGenerator<HostedChatTurnDelta, void, unknown> {
  const model = input.model ?? "";
  if (
    model === OPENPOND_SCRIPTED_SUBAGENT_RUNNING_MODEL ||
    model === OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL
  ) {
    await delay(SCRIPTED_SUBAGENT_RUNNING_DELAY_MS);
  }

  if (model === OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL && toolNames.has("openpond_subagent_send_message")) {
    const messageResult = latestToolResult(input.messages, "openpond_subagent_send_message");
    if (!messageResult) {
      yield toolCallDelta("openpond_subagent_send_message", {
        toRole: "parent",
        kind: "handoff",
        priority: "normal",
        body: "Scripted child handoff from the desktop harness.",
      });
      yield finishDelta("tool_calls");
      return;
    }
  }

  yield textDelta(scriptedChildText(model));
  yield finishDelta("stop");
}

function* streamSubagentCancellation(
  input: HostedChatTurnInput,
  toolNames: Set<string | undefined>,
  runId: string,
): Generator<HostedChatTurnDelta, void, unknown> {
  const cancelResult = latestToolResult(input.messages, "openpond_subagent_cancel");
  if (toolNames.has("openpond_subagent_cancel") && !cancelResult) {
    yield toolCallDelta("openpond_subagent_cancel", {
      runId,
      reason: "Scripted desktop harness cancellation proof.",
      cleanupWorkspace: true,
    });
    yield finishDelta("tool_calls");
    return;
  }

  const status = subagentStatusFromResult(cancelResult) ?? "cancelled";
  yield textDelta(`Research subagent cancellation finished with ${status} status for ${runId}.`);
  yield finishDelta("stop");
}

function scriptedSubagentObjective(model: string): string {
  if (model === OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL) {
    return "Attempt write-capable work in a non-git workspace so the desktop harness can verify blocked subagent UI.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_RUNNING_MODEL) {
    return "Stay running briefly so the desktop harness can verify visible subagent running state.";
  }
  if (model === OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL) {
    return "Stay running under an active goal so the desktop harness can verify Goal strip and details UI.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL) {
    return "Send a deterministic handoff message to the parent and then finish.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_CANCEL_MODEL) {
    return "Start a child run that the parent will cancel for deterministic cancellation proof.";
  }
  return "Inspect the scripted desktop harness lifecycle and report a concise finding.";
}

function scriptedSubagentRoleId(model: string): string {
  return model === OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL ? "coding" : "research";
}

function scriptedSubagentRoleLabel(model: string): string {
  return model === OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL ? "Coding" : "Research";
}

function scriptedChildText(model: string): string {
  if (model === OPENPOND_SCRIPTED_SUBAGENT_RUNNING_MODEL) {
    return "Research subagent completed after the scripted running-state delay.";
  }
  if (model === OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL) {
    return "Research subagent completed after the scripted goal-scoped running-state delay.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL) {
    return "Research subagent completed after sending the scripted parent handoff.";
  }
  return "Research subagent completed the scripted lifecycle check.";
}

function textDelta(text: string): HostedChatTurnDelta {
  return {
    type: "text_delta",
    text,
    raw: { scripted: true, text },
  };
}

function finishDelta(finishReason: string | null): HostedChatTurnDelta {
  return {
    type: "finish",
    finishReason,
    raw: { scripted: true, finishReason },
  };
}

function toolCallDelta(name: string, args: Record<string, unknown>): HostedChatTurnDelta {
  const toolCall: HostedChatToolCall = {
    id: `call_${name}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
  return {
    type: "tool_call_delta",
    toolCalls: [toolCall],
    raw: { scripted: true, toolCalls: [toolCall] },
  };
}

function latestUserText(messages: HostedChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && message.content?.trim()) return message.content.trim();
  }
  return null;
}

function isScriptedSubagentChildTurn(messages: HostedChatMessage[]): boolean {
  return messages.some((message) =>
    typeof message.content === "string" &&
    message.content.includes("You are an OpenPond") &&
    message.content.includes("subagent running in an addressable child conversation")
  );
}

function isScriptedParentWakeTurn(messages: HostedChatMessage[]): boolean {
  return messages.some((message) =>
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.includes("subagent sent a") &&
    message.content.includes("to this main chat")
  );
}

function scriptedParentWakeRunId(messages: HostedChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || typeof message.content !== "string") continue;
    if (!message.content.includes("subagent sent a") || !message.content.includes("to this main chat")) continue;
    const match = /^Child run:\s*(\S+)/m.exec(message.content);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function latestToolResult(messages: HostedChatMessage[], action: string): Record<string, unknown> | null {
  return latestToolResultForActions(messages, new Set([action]));
}

function latestToolResultForActions(
  messages: HostedChatMessage[],
  actions: Set<string>,
): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "tool" || !message.content) continue;
    const parsed = parseToolContent(message.content);
    if (typeof parsed?.action === "string" && actions.has(parsed.action)) return parsed;
  }
  return null;
}

function latestSubagentInspection(messages: HostedChatMessage[]): Record<string, unknown> | null {
  return latestToolResultForActions(messages, new Set(["openpond_subagent_join", "openpond_subagent_status"]));
}

function subagentRunIdFromResult(result: Record<string, unknown> | null): string | null {
  return stringFromPath(result, ["runId"]) ??
    stringFromPath(result, ["id"]) ??
    stringFromPath(result, ["runs", "0", "runId"]) ??
    stringFromPath(result, ["data", "runId"]) ??
    stringFromPath(result, ["data", "id"]) ??
    stringFromPath(result, ["data", "runs", "0", "runId"]);
}

function subagentStatusFromResult(result: Record<string, unknown> | null): string | null {
  return stringFromPath(result, ["status"]) ??
    stringFromPath(result, ["runs", "0", "status"]) ??
    stringFromPath(result, ["data", "status"]) ??
    stringFromPath(result, ["data", "runs", "0", "status"]);
}

function toolResultCount(messages: HostedChatMessage[], action: string): number {
  return toolResults(messages, action).length;
}

function toolResults(messages: HostedChatMessage[], action: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || !message.content) continue;
    const parsed = parseToolContent(message.content);
    if (parsed?.action === action) results.push(parsed);
  }
  return results;
}

function parseToolContent(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringFromPath(record: Record<string, unknown> | null, path: string[]): string | null {
  let current: unknown = record;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return null;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
