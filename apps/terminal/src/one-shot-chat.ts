import { readFile } from "node:fs/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable } from "node:stream";
import type { Writable } from "node:stream";
import {
  ContextUsageSnapshotSchema,
  type BootstrapPayload,
  type ContextUsageSnapshot,
  type RuntimeEvent,
} from "@openpond/contracts";
import type { TerminalOptions } from "./args.js";
import { apiFetch, ensureServer, stopManagedServer } from "./connection.js";
import { openTerminalEvents, type TerminalEventStreamController } from "./events.js";
import { activeModelId, activeModelRef, modelLabel, providerLabel } from "./formatting.js";
import { ensureTerminalChatSession } from "./session-state.js";

export type OneShotChatStatus = "completed" | "failed" | "interrupted" | "timeout";
type OneShotTerminalState = "turn.completed" | "turn.failed" | "turn.interrupted" | "timeout" | "error";

export type OneShotChatResult = {
  status: OneShotChatStatus;
  sessionId: string | null;
  turnId: string | null;
  provider: string;
  model: string | null;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  finalMessage: string;
  output: {
    finalMessageBytes: number;
    truncated: boolean;
    maxOutputBytes: number | null;
  };
  events: {
    terminal: OneShotTerminalState;
    total: number;
    commands: number;
    workspaceActions: number;
  };
  usage: ContextUsageSnapshot | null;
  error: string | null;
};

type TerminalTurnRuntimeEvent = RuntimeEvent & {
  name: "turn.completed" | "turn.failed" | "turn.interrupted";
};

type OneShotChatIo = {
  input?: Readable;
  output?: Writable;
  connection?: { server: string; token: string };
};

type OneShotAccumulator = ReturnType<typeof createOneShotAccumulator>;

export class TerminalOneShotExitError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "TerminalOneShotExitError";
  }
}

export async function runOneShotChat(options: TerminalOptions, io: OneShotChatIo = {}): Promise<OneShotChatResult> {
  const output = io.output ?? defaultOutput;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const prompt = await resolveOneShotPrompt(options, io.input ?? defaultInput);
  if (!prompt.trim()) {
    throw new TerminalOneShotExitError("openpond chat --non-interactive requires --message, --message-file, or --stdin input.", 2);
  }

  const startupWarnings: string[] = [];
  let connection: { server: string; token: string } | null = null;
  let eventStream: TerminalEventStreamController | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let activeSessionId: string | null = null;
  let selectedModel: string | null = options.model;
  let accumulator: OneShotAccumulator | null = null;

  try {
    connection = io.connection ?? await ensureServer(options, (line) => startupWarnings.push(line));
    const payload = await apiFetch<BootstrapPayload>(connection.server, connection.token, "/v1/bootstrap?refreshCodex=1");
    const sessionState = await ensureTerminalChatSession(
      connection,
      payload,
      { ...options, headless: true },
      options.resume,
    );
    activeSessionId = sessionState.sessionId;
    options.provider = sessionState.provider;
    options.model = sessionState.model;
    selectedModel = sessionState.model;

    const modelId = activeModelId(options, payload.providers);
    if (!modelId) {
      throw new Error(`No model selected for ${providerLabel(payload.providers, options.provider)}.`);
    }
    selectedModel = modelId;

    if (!options.json) {
      for (const line of startupWarnings) output.write(`${line}\n`);
      output.write(`OpenPond ${providerLabel(payload.providers, options.provider)} / ${modelLabel(payload.providers, options)} ${options.cwd}\n`);
    }

    const activeAccumulator = createOneShotAccumulator({ maxOutputBytes: options.maxOutputBytes });
    accumulator = activeAccumulator;
    let resolveTerminalEvent = (_event: TerminalTurnRuntimeEvent): void => undefined;
    const terminalEventPromise = new Promise<TerminalTurnRuntimeEvent>((resolve) => {
      resolveTerminalEvent = resolve;
    });
    eventStream = openOneShotTerminalEvents({
      server: connection.server,
      token: connection.token,
      activeSessionId,
      onEvent: (event) => {
        activeAccumulator.apply(event);
        if (!options.json) output.write(humanOneShotEventText(event));
        if (isTerminalTurnEvent(event)) resolveTerminalEvent(event);
      },
      onStatus: (message) => {
        if (!options.json) output.write(message);
      },
    });

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      if (!options.timeoutSec) return;
      timeout = setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, options.timeoutSec * 1000);
    });

    const streamReady = await Promise.race([
      eventStream.ready.then(() => "ready" as const),
      timeoutPromise,
    ]);
    if (streamReady === "timeout") {
      const result = activeAccumulator.result({
        terminal: "timeout",
        sessionId: activeSessionId,
        provider: options.provider,
        model: modelId,
        cwd: options.cwd,
        startedAt,
        startedAtMs,
        error: `Timed out after ${options.timeoutSec}s.`,
      });
      writeOneShotResult(output, options, result);
      process.exitCode = 124;
      return result;
    }

    await apiFetch(connection.server, connection.token, `/v1/sessions/${activeSessionId}/turns`, {
      method: "POST",
      body: JSON.stringify({
        prompt,
        cwd: options.cwd,
        model: modelId,
        modelRef: activeModelRef(options, payload.providers),
        approvalPolicy: options.yes ? "never" : options.approvalPolicy,
        sandbox: options.sandbox,
        metadata: {
          openpondTerminalMode: "one-shot",
          openpondTerminal: {
            mode: "one-shot",
            nonInteractive: true,
            sandbox: options.sandbox,
          },
        },
      }),
    });

    const terminal = await Promise.race([terminalEventPromise, timeoutPromise]);
    if (terminal === "timeout") {
      await interruptOneShotTurn(connection.server, connection.token, activeSessionId);
      const result = activeAccumulator.result({
        terminal: "timeout",
        sessionId: activeSessionId,
        provider: options.provider,
        model: modelId,
        cwd: options.cwd,
        startedAt,
        startedAtMs,
        error: `Timed out after ${options.timeoutSec}s.`,
      });
      writeOneShotResult(output, options, result);
      process.exitCode = 124;
      return result;
    }

    const result = activeAccumulator.result({
      terminal: terminal.name,
      sessionId: activeSessionId,
      provider: options.provider,
      model: modelId,
      cwd: options.cwd,
      startedAt,
      startedAtMs,
      error: terminal.error ?? (terminal.name === "turn.failed" ? terminal.output ?? "Turn failed." : null),
    });
    writeOneShotResult(output, options, result);
    if (result.status !== "completed") process.exitCode = 1;
    return result;
  } catch (error) {
    if (error instanceof TerminalOneShotExitError) throw error;
    const result = (accumulator ?? createOneShotAccumulator({ maxOutputBytes: options.maxOutputBytes })).result({
      terminal: "error",
      sessionId: activeSessionId,
      provider: options.provider,
      model: selectedModel,
      cwd: options.cwd,
      startedAt,
      startedAtMs,
      error: error instanceof Error ? error.message : String(error),
    });
    writeOneShotResult(output, options, result);
    process.exitCode = 1;
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    const activeEventStream = eventStream as TerminalEventStreamController | null;
    activeEventStream?.abort();
    if (!io.connection) stopManagedServer();
    if (timedOut && !options.json) output.write("\n[turn timeout]\n");
  }
}

export function createOneShotAccumulator(options: { maxOutputBytes?: number | null } = {}): {
  apply(event: RuntimeEvent): void;
  result(input: {
    terminal: OneShotTerminalState;
    sessionId: string | null;
    provider: string;
    model: string | null;
    cwd: string;
    startedAt: string;
    startedAtMs: number;
    error: string | null;
  }): OneShotChatResult;
} {
  let total = 0;
  let commands = 0;
  let workspaceActions = 0;
  let finalMessage = "";
  let finalMessageBytes = 0;
  let finalMessageTruncated = false;
  let turnId: string | null = null;
  let usage: ContextUsageSnapshot | null = null;
  const maxOutputBytes = options.maxOutputBytes ?? null;

  return {
    apply(event) {
      total += 1;
      if (event.turnId) turnId = event.turnId;
      if (event.name === "assistant.delta" && event.output && !finalMessageTruncated) {
        const next = appendWithinByteLimit(finalMessage, finalMessageBytes, event.output, maxOutputBytes);
        finalMessage = next.text;
        finalMessageBytes = next.bytes;
        finalMessageTruncated = next.truncated;
      }
      if (event.name === "command.output" || (event.name === "tool.completed" && event.action === "exec_command")) {
        commands += 1;
      }
      if (event.name === "workspace_action" || event.name === "workspace_action_result") workspaceActions += 1;
      const usageSnapshot = contextUsageFromEvent(event);
      if (usageSnapshot) usage = usageSnapshot;
    },
    result(input) {
      const finishedAtMs = Date.now();
      const terminal = input.terminal;
      return {
        status: terminalStatus(terminal),
        sessionId: input.sessionId,
        turnId,
        provider: input.provider,
        model: input.model,
        cwd: input.cwd,
        startedAt: input.startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - input.startedAtMs),
        finalMessage,
        output: {
          finalMessageBytes,
          truncated: finalMessageTruncated,
          maxOutputBytes,
        },
        events: {
          terminal,
          total,
          commands,
          workspaceActions,
        },
        usage,
        error: input.error,
      };
    },
  };
}

function contextUsageFromEvent(event: RuntimeEvent): ContextUsageSnapshot | null {
  if (event.name !== "session.context.updated") return null;
  const parsed = ContextUsageSnapshotSchema.safeParse(event.data);
  if (!parsed.success) return null;
  if (parsed.data.source === "heuristic") return null;
  return parsed.data;
}

function appendWithinByteLimit(
  current: string,
  currentBytes: number,
  chunk: string,
  maxBytes: number | null,
): { text: string; bytes: number; truncated: boolean } {
  if (maxBytes === null) {
    return {
      text: current + chunk,
      bytes: currentBytes + utf8Bytes(chunk),
      truncated: false,
    };
  }
  let text = current;
  let bytes = currentBytes;
  for (const char of chunk) {
    const charBytes = utf8Bytes(char);
    if (bytes + charBytes > maxBytes) {
      return { text, bytes, truncated: true };
    }
    text += char;
    bytes += charBytes;
  }
  return { text, bytes, truncated: false };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function resolveOneShotPrompt(options: TerminalOptions, input: Readable): Promise<string> {
  const parts: string[] = [];
  const inputIsTty = Boolean((input as { isTTY?: boolean }).isTTY);
  const explicitSources = [
    options.message !== null ? "--message" : null,
    options.messageFile !== null ? "--message-file" : null,
    options.stdin ? "--stdin" : null,
  ].filter((source): source is string => source !== null);
  if (explicitSources.length > 1) {
    throw new TerminalOneShotExitError(
      `openpond chat --non-interactive accepts exactly one instruction source; received ${explicitSources.join(", ")}.`,
      2,
    );
  }
  if (options.message !== null) parts.push(options.message);
  if (options.messageFile) parts.push(await readOneShotMessageFile(options.messageFile));
  if (options.stdin || (options.nonInteractive && !inputIsTty && !options.message && !options.messageFile)) {
    parts.push(await readAll(input));
  }
  return parts.join("\n\n").trimEnd();
}

async function readOneShotMessageFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TerminalOneShotExitError(`openpond chat --message-file could not read ${filePath}: ${detail}`, 2);
  }
}

async function readAll(input: Readable): Promise<string> {
  let text = "";
  input.setEncoding("utf8");
  for await (const chunk of input) text += String(chunk);
  return text;
}

function openOneShotTerminalEvents(input: {
  server: string;
  token: string;
  activeSessionId: string;
  onEvent: (event: RuntimeEvent) => void;
  onStatus: (message: string) => void;
}): TerminalEventStreamController {
  const pending = openTerminalEvents({
    server: input.server,
    token: input.token,
    activeSessionId: () => input.activeSessionId,
    onEvent: input.onEvent,
    onStatus: (status) => {
      if (status.state === "disconnected") {
        input.onStatus(`\n[event stream] reconnecting in ${Math.ceil(status.nextDelayMs / 1000)}s: ${status.message}\n`);
      }
    },
  });
  const fallback = new AbortController() as TerminalEventStreamController;
  fallback.ready = pending.then((controller) => controller.ready);
  pending.then((controller) => {
    if (fallback.signal.aborted) controller.abort();
    else {
      fallback.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }).catch(() => undefined);
  return fallback;
}

async function interruptOneShotTurn(server: string, token: string, sessionId: string): Promise<void> {
  await apiFetch(server, token, `/v1/sessions/${sessionId}/turns/interrupt`, { method: "POST" }).catch(() => undefined);
}

function writeOneShotResult(output: Writable, options: TerminalOptions, result: OneShotChatResult): void {
  if (options.json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  output.write(`\n[turn ${result.status}]\n`);
}

function humanOneShotEventText(event: RuntimeEvent): string {
  if (event.name === "assistant.delta") return event.output ?? "";
  if (event.name === "approval.requested") return `\n[approval] ${event.output ?? event.action ?? "request"}\n`;
  if (event.name === "command.output" && event.output) return `\n[command] ${event.output}\n`;
  if (event.name.startsWith("workspace_")) return `\n[openpond] ${event.output ?? event.action ?? event.name}\n`;
  return "";
}

function isTerminalTurnEvent(event: RuntimeEvent): event is TerminalTurnRuntimeEvent {
  return event.name === "turn.completed" || event.name === "turn.failed" || event.name === "turn.interrupted";
}

function terminalStatus(terminal: OneShotChatResult["events"]["terminal"]): OneShotChatStatus {
  if (terminal === "turn.completed") return "completed";
  if (terminal === "turn.interrupted") return "interrupted";
  if (terminal === "timeout") return "timeout";
  return "failed";
}
