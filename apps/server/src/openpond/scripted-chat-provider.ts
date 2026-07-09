import type { HostedChatMessage, HostedChatToolCall } from "@openpond/cloud";
import type { HostedChatTurnDelta, HostedChatTurnInput } from "@openpond/runtime";

export const OPENPOND_SCRIPTED_MODEL_PREFIX = "openpond-scripted-";
export const OPENPOND_HARNESS_SCRIPTED_MODELS_ENV = "OPENPOND_HARNESS_SCRIPTED_MODELS";
export const OPENPOND_SCRIPTED_CHAT_TWO_TURNS_MODEL = "openpond-scripted-chat-two-turns";
export const OPENPOND_SCRIPTED_SUBAGENT_LIFECYCLE_MODEL = "openpond-scripted-subagent-lifecycle";
export const OPENPOND_SCRIPTED_SUBAGENT_RUNNING_MODEL = "openpond-scripted-subagent-running-delay";
export const OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL = "openpond-scripted-goal-subagent-running";
export const OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL = "openpond-scripted-subagent-handoff";
export const OPENPOND_SCRIPTED_SUBAGENT_WATCH_SUBMISSION_MODEL = "openpond-scripted-subagent-watch-submission";
export const OPENPOND_SCRIPTED_SUBAGENT_PROGRESS_ONLY_MODEL = "openpond-scripted-subagent-progress-only";
export const OPENPOND_SCRIPTED_SUBAGENT_STALE_MODEL = "openpond-scripted-subagent-stale";
export const OPENPOND_SCRIPTED_SUBAGENT_REVIEW_REVISION_MODEL = "openpond-scripted-subagent-review-revision";
export const OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL = "openpond-scripted-subagent-bounded-worker";
export const OPENPOND_SCRIPTED_SUBAGENT_CANCEL_MODEL = "openpond-scripted-subagent-cancel";
export const OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL = "openpond-scripted-subagent-blocker";

const SCRIPTED_SUBAGENT_RUNNING_DELAY_MS = 8_000;
const SCRIPTED_GOAL_PARENT_RUNNING_DELAY_MS = 12_000;
const SCRIPTED_SUBAGENT_BACKGROUND_WATCH_DELAY_MS = 16_000;
const SCRIPTED_SUBAGENT_STALE_DELAY_MS = 30_000;
const SCRIPTED_BOUNDED_WORKER_PROOF_PATH = "bounded-worker-contract-proof.txt";
const SCRIPTED_BOUNDED_WORKER_WRITE_COMMAND =
  "printf '%s\\n' 'bounded-worker-contract' 'copy-on-write child edit' > bounded-worker-contract-proof.txt";
const SCRIPTED_BOUNDED_WORKER_VALIDATION_COMMAND =
  "test -f bounded-worker-contract-proof.txt && grep -q bounded-worker-contract bounded-worker-contract-proof.txt";

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
    model === OPENPOND_SCRIPTED_SUBAGENT_WATCH_SUBMISSION_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_PROGRESS_ONLY_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_STALE_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_REVIEW_REVISION_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL ||
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
  const lifecycleWakeRunId = scriptedLifecycleWakeRunId(input.messages);
  const lifecycleWakeStatus = scriptedLifecycleWakeStatus(input.messages);
  const lifecycleWakeText = scriptedLifecycleWakeText(input.messages);
  const startResult = latestToolResult(input.messages, "openpond_subagent_start");
  const currentWakeReviewResult = latestToolResultAfterLatestLifecycleWake(input.messages, "openpond_subagent_review");
  const latestResult = latestSubagentInspection(input.messages);
  if (model === OPENPOND_SCRIPTED_SUBAGENT_REVIEW_REVISION_MODEL && lifecycleWakeRunId) {
    if (currentWakeReviewResult) {
      const reviewStatus = subagentStatusFromResult(currentWakeReviewResult);
      yield textDelta(reviewStatus === "accepted"
        ? `Parent accepted revised subagent work for ${lifecycleWakeRunId}.`
        : `Parent requested child revision for ${lifecycleWakeRunId}.`);
      yield finishDelta("stop");
      return;
    }
    if (toolNames.has("openpond_subagent_review")) {
      const previousReviewResults = toolResults(input.messages, "openpond_subagent_review");
      const alreadyRequestedRevision = previousReviewResults.some((result) =>
        subagentStatusFromResult(result) === "needs_revision"
      );
      const revisedPacketSubmitted = lifecycleWakeText
        ? /\brevised review packet\b/i.test(lifecycleWakeText) ||
          /\brequested regression proof\b/i.test(lifecycleWakeText)
        : false;
      if ((alreadyRequestedRevision || revisedPacketSubmitted) && lifecycleWakeStatus === "submitted_for_review") {
        yield toolCallDelta("openpond_subagent_review", {
            runId: lifecycleWakeRunId,
            decision: "accept",
            summary: "The revised review packet includes the requested regression proof.",
          });
        yield finishDelta("tool_calls");
        return;
      }
      if (lifecycleWakeStatus === "needs_revision") {
        yield textDelta(`Parent is waiting for child revision for ${lifecycleWakeRunId}.`);
        yield finishDelta("stop");
        return;
      }
      if (lifecycleWakeStatus !== "submitted_for_review") {
        yield textDelta(`Parent noted lifecycle status ${lifecycleWakeStatus ?? "unknown"} for ${lifecycleWakeRunId}.`);
        yield finishDelta("stop");
        return;
      }
      yield toolCallDelta("openpond_subagent_review", {
        runId: lifecycleWakeRunId,
        decision: "needs_revision",
        summary: "The initial packet is missing a focused regression proof.",
        issues: ["The child submission did not show the requested unchanged-insight regression proof."],
        requiredCorrections: ["Add the focused unchanged-insight regression proof and submit a revised packet."],
        priority: "interrupt",
      });
      yield finishDelta("tool_calls");
      return;
    }
  }
  if (!startResult && lifecycleWakeRunId) {
    yield textDelta(`Watcher lifecycle review wake received for ${lifecycleWakeRunId}.`);
    yield finishDelta("stop");
    return;
  }
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
      required: scriptedSubagentRequired(model, input.messages),
      ...scriptedSubagentStartExtras(model),
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
  if (model === OPENPOND_SCRIPTED_SUBAGENT_WATCH_SUBMISSION_MODEL && latestResult === null) {
    yield textDelta(`Research subagent submitted for watcher review for ${runId}.`);
    yield finishDelta("stop");
    return;
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_PROGRESS_ONLY_MODEL && latestResult === null) {
    yield textDelta(`Research subagent progress-only child started for ${runId}.`);
    yield finishDelta("stop");
    return;
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_STALE_MODEL && latestResult === null) {
    yield textDelta(`Research subagent stale-watch child started for ${runId}.`);
    yield finishDelta("stop");
    return;
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_REVIEW_REVISION_MODEL && latestResult === null) {
    yield textDelta(`Research subagent review-revision child started for ${runId}.`);
    yield finishDelta("stop");
    return;
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL && latestResult === null) {
    yield textDelta(`Coding subagent bounded-worker child started for ${runId}.`);
    yield finishDelta("stop");
    return;
  }

  const latestStatus = subagentStatusFromResult(latestResult) ?? subagentStatusFromResult(startResult);
  if (latestStatus === "submitted_for_review") {
    yield textDelta(`Research subagent lifecycle submitted for review for ${runId}.`);
    yield finishDelta("stop");
    return;
  }
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
  if (model === OPENPOND_SCRIPTED_SUBAGENT_PROGRESS_ONLY_MODEL) {
    await delay(SCRIPTED_SUBAGENT_BACKGROUND_WATCH_DELAY_MS);
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_STALE_MODEL) {
    await delay(SCRIPTED_SUBAGENT_STALE_DELAY_MS);
  }

  if (model === OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL) {
    yield* streamScriptedBoundedWorkerChild(input, toolNames);
    return;
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

  yield textDelta(scriptedChildText(model, input.messages));
  yield finishDelta("stop");
}

function* streamScriptedBoundedWorkerChild(
  input: HostedChatTurnInput,
  toolNames: Set<string | undefined>,
): Generator<HostedChatTurnDelta, void, unknown> {
  const searchCount = toolResultCount(input.messages, "resource_search");
  if (toolNames.has("resource_search") && searchCount < 2) {
    yield toolCallDelta("resource_search", {
      scope: "workspace",
      query: "package.json",
      limit: 5,
      filters: { mode: "path" },
    });
    yield finishDelta("tool_calls");
    return;
  }

  if (toolNames.has("resource_read") && !latestToolResult(input.messages, "resource_read")) {
    yield toolCallDelta("resource_read", {
      ref: "workspace:file:package.json",
      mode: "summary",
    });
    yield finishDelta("tool_calls");
    return;
  }

  if (
    toolNames.has("exec_command") &&
    !hasExecCommandResult(input.messages, SCRIPTED_BOUNDED_WORKER_WRITE_COMMAND)
  ) {
    yield toolCallDelta("exec_command", {
      command: SCRIPTED_BOUNDED_WORKER_WRITE_COMMAND,
      timeoutSeconds: 30,
    });
    yield finishDelta("tool_calls");
    return;
  }

  if (
    toolNames.has("exec_command") &&
    !hasExecCommandResult(input.messages, SCRIPTED_BOUNDED_WORKER_VALIDATION_COMMAND)
  ) {
    yield toolCallDelta("exec_command", {
      command: SCRIPTED_BOUNDED_WORKER_VALIDATION_COMMAND,
      timeoutSeconds: 30,
    });
    yield finishDelta("tool_calls");
    return;
  }

  yield textDelta(scriptedChildText(OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL, input.messages));
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
  if (model === OPENPOND_SCRIPTED_SUBAGENT_WATCH_SUBMISSION_MODEL) {
    return "Submit a deterministic review packet so the lifecycle watcher can wake the parent.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_PROGRESS_ONLY_MODEL) {
    return "Stay active across one background watcher interval without asking the parent for routine progress.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_STALE_MODEL) {
    return "Stay active long enough for the desktop harness to age the run and verify stale watcher policy.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_REVIEW_REVISION_MODEL) {
    return "Submit an initial packet, receive parent revision feedback, revise, and submit a second packet for acceptance.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL) {
    return "Prove bounded worker execution in copy-on-write isolation with a typed brief, workspace edit, and validation.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_CANCEL_MODEL) {
    return "Start a child run that the parent will cancel for deterministic cancellation proof.";
  }
  return "Inspect the scripted desktop harness lifecycle and report a concise finding.";
}

function scriptedSubagentRequired(model: string, messages: HostedChatMessage[]): boolean {
  if (model === OPENPOND_SCRIPTED_SUBAGENT_STALE_MODEL) {
    return !/\boptional\b/i.test(latestUserText(messages) ?? "");
  }
  return true;
}

function scriptedSubagentStartExtras(model: string): Record<string, unknown> {
  if (model !== OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL) return {};
  return {
    context: [
      "This deterministic desktop harness proof may edit only the isolated copy-on-write child worktree.",
      "Do not edit the parent checkout.",
    ].join(" "),
    workerBrief: {
      plan: [
        "Inspect workspace context.",
        "Create the bounded worker proof file in the isolated child worktree.",
        "Run the focused validation command.",
        "Submit a review packet without self-accepting.",
      ],
      targetFiles: ["package.json", SCRIPTED_BOUNDED_WORKER_PROOF_PATH],
      acceptanceCriteria: [
        "The child writes bounded-worker-contract-proof.txt only in the copy-on-write worktree.",
        "The validation command passes in the child worktree.",
        "The run is submitted_for_review and not accepted by the child.",
      ],
      validationCommands: [SCRIPTED_BOUNDED_WORKER_VALIDATION_COMMAND],
      stopConditions: [
        "Stop and report a blocker if copy-on-write isolation or validation is unavailable.",
      ],
    },
  };
}

function scriptedSubagentRoleId(model: string): string {
  return model === OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL
    ? "coding"
    : "research";
}

function scriptedSubagentRoleLabel(model: string): string {
  return model === OPENPOND_SCRIPTED_SUBAGENT_BLOCKER_MODEL ||
    model === OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL
    ? "Coding"
    : "Research";
}

function scriptedChildText(model: string, messages: HostedChatMessage[] = []): string {
  if (model === OPENPOND_SCRIPTED_SUBAGENT_RUNNING_MODEL) {
    return "Research subagent submitted after the scripted running-state delay.";
  }
  if (model === OPENPOND_SCRIPTED_GOAL_SUBAGENT_RUNNING_MODEL) {
    return "Research subagent submitted after the scripted goal-scoped running-state delay.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_HANDOFF_MODEL) {
    return "Research subagent submitted after sending the scripted parent handoff.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_WATCH_SUBMISSION_MODEL) {
    return "Research subagent submitted the scripted watcher review packet.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_PROGRESS_ONLY_MODEL) {
    return "Research subagent submitted after the progress-only watcher interval proof.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_STALE_MODEL) {
    return "Research subagent submitted after the stale watcher policy proof.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_REVIEW_REVISION_MODEL) {
    return childHasRevisionRequest(messages)
      ? "Research subagent submitted the revised review packet with the requested regression proof."
      : "Research subagent submitted the initial review packet missing the regression proof.";
  }
  if (model === OPENPOND_SCRIPTED_SUBAGENT_BOUNDED_WORKER_MODEL) {
    return "Coding subagent submitted the bounded worker contract packet after editing and validation.";
  }
  return "Research subagent submitted the scripted lifecycle check.";
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
    id: `call_${name}_${stableToolCallSuffix(args)}`,
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

function stableToolCallSuffix(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
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

function scriptedLifecycleWakeRunId(messages: HostedChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || typeof message.content !== "string") continue;
    if (!message.content.includes("subagent lifecycle watcher found required child work")) continue;
    const match = /^Run\s+(\S+)\s+\(/m.exec(message.content);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function scriptedLifecycleWakeStatus(messages: HostedChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || typeof message.content !== "string") continue;
    if (!message.content.includes("subagent lifecycle watcher found required child work")) continue;
    const match = /^Status:\s*(\S+)/m.exec(message.content);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function scriptedLifecycleWakeText(messages: HostedChatMessage[]): string | null {
  const wakeIndex = latestLifecycleWakeMessageIndex(messages);
  if (wakeIndex === -1) return null;
  const content = messages[wakeIndex]?.content;
  return typeof content === "string" ? content : null;
}

function childHasRevisionRequest(messages: HostedChatMessage[]): boolean {
  return messages.some((message) =>
    typeof message.content === "string" &&
    message.content.includes("Review decision: needs_revision")
  );
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

function latestToolResultAfterLatestLifecycleWake(
  messages: HostedChatMessage[],
  action: string,
): Record<string, unknown> | null {
  const wakeIndex = latestLifecycleWakeMessageIndex(messages);
  if (wakeIndex === -1) return null;
  for (let index = messages.length - 1; index > wakeIndex; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "tool" || !message.content) continue;
    const parsed = parseToolContent(message.content);
    if (parsed?.action === action) return parsed;
  }
  return null;
}

function latestLifecycleWakeMessageIndex(messages: HostedChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.includes("subagent lifecycle watcher found required child work")
    ) {
      return index;
    }
  }
  return -1;
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

function hasExecCommandResult(messages: HostedChatMessage[], command: string): boolean {
  const expected = command.trim();
  return toolResults(messages, "exec_command").some((result) =>
    stringFromPath(result, ["data", "command"])?.trim() === expected ||
    stringFromPath(result, ["data", "command", "command"])?.trim() === expected
  );
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
