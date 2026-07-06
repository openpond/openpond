import { randomUUID } from "node:crypto";
import {
  type RuntimeEvent,
  type Session,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import { event } from "../utils.js";
import { resolveWorkspaceExecutionTarget } from "../workspace/workspace-execution-target.js";
import {
  commandResultForModel,
  SELECT_PROJECT_MESSAGE,
  type OpenPondCommandExecutionInput,
  type OpenPondCommandRunResult,
} from "./command-access.js";

const DEFAULT_DIRECT_COMMAND_TIMEOUT_SECONDS = 120;
const MAX_DIRECT_COMMAND_TIMEOUT_SECONDS = 3600;

export type OpenPondDirectCommandResult = OpenPondCommandRunResult | WorkspaceToolResult;

export type OpenPondDirectCommandResponse = {
  session: Session;
  events: RuntimeEvent[];
  result: OpenPondDirectCommandResult;
};

export type OpenPondDirectCommandInput = {
  session: Session;
  command: string;
  cwd?: string | null;
  timeoutSeconds?: number | null;
};

export type OpenPondDirectCommandDeps = {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  createCommandRunId?: () => string;
  executeLocalCommand: (input: OpenPondCommandExecutionInput) => Promise<OpenPondCommandRunResult>;
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string },
  ) => Promise<WorkspaceToolResult>;
  getSession: (sessionId: string) => Promise<Session>;
  runtimeEventsSnapshot?: () => Promise<RuntimeEvent[]>;
};

export async function runOpenPondDirectCommand(
  deps: OpenPondDirectCommandDeps,
  input: OpenPondDirectCommandInput,
): Promise<OpenPondDirectCommandResponse> {
  const commandRunId = deps.createCommandRunId?.() ?? `direct_command_${randomUUID()}`;
  const target = resolveWorkspaceExecutionTarget({ session: input.session });
  if (target.target === "sandbox") {
    if (!target.ready) {
      return runBlockedDirectCommand(deps, input, commandRunId, SELECT_PROJECT_MESSAGE);
    }
    return runSandboxDirectCommand(deps, input, commandRunId);
  }
  return runLocalDirectCommand(deps, input, commandRunId);
}

async function runBlockedDirectCommand(
  deps: OpenPondDirectCommandDeps,
  input: OpenPondDirectCommandInput,
  commandRunId: string,
  blockedReason: string,
): Promise<OpenPondDirectCommandResponse> {
  const result: OpenPondCommandRunResult = {
    ok: false,
    command: input.command.trim(),
    cwd: input.cwd ?? input.session.cwd ?? null,
    exitCode: null,
    stdout: "",
    stderr: blockedReason,
    timedOut: false,
    timeoutSeconds: normalizedDirectCommandTimeout(input.timeoutSeconds),
    truncated: false,
    blockedReason,
  };
  const started = event({
    sessionId: input.session.id,
    turnId: commandRunId,
    name: "tool.started",
    source: "chat_action",
    action: "exec_command",
    appId: input.session.appId,
    args: { command: input.command },
    status: "started",
    data: {
      toolCallId: commandRunId,
      tool: "exec_command",
      type: "direct_command",
      command: input.command,
      cwd: result.cwd,
    },
  });
  await deps.appendRuntimeEvent(started);
  const resultText = commandResultForModel(result);
  const completed = event({
    sessionId: input.session.id,
    turnId: commandRunId,
    name: "tool.completed",
    source: "chat_action",
    action: "exec_command",
    appId: input.session.appId,
    status: "failed",
    output: resultText,
    error: resultText,
    data: {
      toolCallId: commandRunId,
      tool: "exec_command",
      type: "direct_command",
      result,
      command: result.command,
      cwd: result.cwd,
    },
  });
  await deps.appendRuntimeEvent(completed);
  return {
    session: await deps.getSession(input.session.id),
    events: [started, completed],
    result,
  };
}

async function runLocalDirectCommand(
  deps: OpenPondDirectCommandDeps,
  input: OpenPondDirectCommandInput,
  commandRunId: string,
): Promise<OpenPondDirectCommandResponse> {
  const started = event({
    sessionId: input.session.id,
    turnId: commandRunId,
    name: "tool.started",
    source: "chat_action",
    action: "exec_command",
    appId: input.session.appId,
    args: {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
    },
    status: "started",
    data: {
      toolCallId: commandRunId,
      tool: "exec_command",
      type: "direct_command",
      command: input.command,
      cwd: input.cwd ?? input.session.cwd ?? null,
    },
  });
  await deps.appendRuntimeEvent(started);
  const result = await deps.executeLocalCommand({
    session: input.session,
    turnId: commandRunId,
    providerRequestId: commandRunId,
    command: input.command,
    cwd: input.cwd ?? null,
    timeoutSeconds: input.timeoutSeconds ?? null,
    source: "direct_command",
  });
  const resultText = commandResultForModel(result);
  const completed = event({
    sessionId: input.session.id,
    turnId: commandRunId,
    name: "tool.completed",
    source: "chat_action",
    action: "exec_command",
    appId: input.session.appId,
    status: result.ok ? "completed" : "failed",
    output: resultText,
    error: result.ok ? undefined : resultText,
    data: {
      toolCallId: commandRunId,
      tool: "exec_command",
      type: "direct_command",
      result,
      command: result.command,
      cwd: result.cwd,
    },
  });
  await deps.appendRuntimeEvent(completed);
  return {
    session: await deps.getSession(input.session.id),
    events: [started, completed],
    result,
  };
}

async function runSandboxDirectCommand(
  deps: OpenPondDirectCommandDeps,
  input: OpenPondDirectCommandInput,
  commandRunId: string,
): Promise<OpenPondDirectCommandResponse> {
  const beforeEvents = deps.runtimeEventsSnapshot ? await deps.runtimeEventsSnapshot() : [];
  const beforeEventIds = new Set(beforeEvents.map((item) => item.id));
  const result = await deps.executeWorkspaceTool(
    input.session.id,
    {
      action: "sandbox_exec",
      args: {
        command: input.command,
        ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
      },
      source: "chat_action",
    },
    { turnId: commandRunId },
  );
  const afterEvents = deps.runtimeEventsSnapshot ? await deps.runtimeEventsSnapshot() : [];
  const events = afterEvents.filter(
    (item) =>
      item.sessionId === input.session.id &&
      item.turnId === commandRunId &&
      !beforeEventIds.has(item.id),
  );
  return {
    session: await deps.getSession(input.session.id),
    events,
    result,
  };
}

function normalizedDirectCommandTimeout(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_DIRECT_COMMAND_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(Math.floor(value!), MAX_DIRECT_COMMAND_TIMEOUT_SECONDS));
}
