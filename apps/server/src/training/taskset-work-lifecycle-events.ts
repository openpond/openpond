import type { Session } from "@openpond/contracts";

import type { NativeModelToolResult } from "../openpond/native-tool-calls.js";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";

type LifecycleContext = {
  store: SqliteStore;
  session: Session;
  turnId: string;
};

export async function appendTasksetTurnStarted(input: LifecycleContext & {
  prompt: string;
  tasksetId: string;
  taskId: string;
  attemptId: string;
}) {
  await input.store.appendRuntimeEvent(event({
    sessionId: input.session.id,
    turnId: input.turnId,
    name: "turn.started",
    source: "server",
    appId: input.session.appId,
    status: "started",
    args: {
      prompt: input.prompt,
      automatedTasksetWorkAttempt: true,
      tasksetId: input.tasksetId,
      taskId: input.taskId,
      attemptId: input.attemptId,
    },
  }));
}

export async function appendTasksetToolStarted(input: LifecycleContext & {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}) {
  await input.store.appendRuntimeEvent(event({
    sessionId: input.session.id,
    turnId: input.turnId,
    name: "tool.started",
    source: "server",
    appId: input.session.appId,
    action: input.name,
    status: "started",
    args: input.args,
    data: { toolCallId: input.callId },
  }));
}

export async function appendTasksetToolLifecycle(input: LifecycleContext & {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: NativeModelToolResult;
}) {
  await appendTasksetToolStarted(input);
  await appendTasksetToolCompleted(input);
}

export async function appendTasksetToolCompleted(input: LifecycleContext & {
  callId: string;
  name: string;
  result: NativeModelToolResult;
}) {
  const output = input.result.contentText.slice(0, 10_000);
  await input.store.appendRuntimeEvent(event({
    sessionId: input.session.id,
    turnId: input.turnId,
    name: "tool.completed",
    source: "server",
    appId: input.session.appId,
    action: input.name,
    status: input.result.ok ? "completed" : "failed",
    output,
    error: input.result.ok ? undefined : output,
    data: {
      toolCallId: input.callId,
      result: {
        ...asRecord(input.result.data),
        ok: input.result.ok,
        output,
      },
    },
  }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
