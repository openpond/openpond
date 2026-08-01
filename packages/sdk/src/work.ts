import {
  sendHostedChatTurn,
  type HostedChatMessage,
  type HostedChatTool,
  type HostedChatToolCall,
} from "../../cloud/src/hosted-chat.js";
import type { OpenPondSandboxClient } from "../../cloud/src/sandbox/client.js";
import type { SandboxRecord } from "../../cloud/src/sandbox/types/index.js";

const DEFAULT_MODEL = "openpond-chat";
const DEFAULT_MAX_STEPS = 24;
const MAX_TOOL_OUTPUT_CHARS = 40_000;

export class OpenPondNonExecutingSandboxError extends Error {
  readonly code = "OPENPOND_NON_EXECUTING_SANDBOX";

  constructor(readonly sandboxId: string) {
    super(
      `Sandbox ${sandboxId} accepted a command without executing it. A real remote runner is required for OpenPond Work.`,
    );
    this.name = "OpenPondNonExecutingSandboxError";
  }
}

export type OpenPondWorkHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OpenPondWorkEvent =
  | { type: "status"; message: string }
  | {
      type: "sandbox";
      sandboxId: string;
      state: SandboxRecord["state"];
      runtimeDriver: SandboxRecord["runtimeDriver"];
    }
  | { type: "assistant"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      command: string;
      status: "started" | "succeeded" | "failed";
      output?: string;
      exitCode?: number | null;
    }
  | { type: "done"; sandboxId: string; text: string; steps: number };

export type OpenPondWorkRunInput = {
  prompt: string;
  /** Reuse this sandbox to continue work in an existing conversation. */
  sandboxId?: string;
  /** Repository cloned when a new sandbox is created. */
  repo?: string;
  history?: OpenPondWorkHistoryMessage[];
  model?: string;
  maxSteps?: number;
  budgetUsd?: string;
  /** Test-only escape hatch. Work rejects non-executing simulated sandboxes by default. */
  allowSimulated?: boolean;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  onEvent?: (event: OpenPondWorkEvent) => void | Promise<void>;
};

export type OpenPondWorkRunResult = {
  sandboxId: string;
  text: string;
  steps: number;
};

type WorkClientInput = {
  apiKey: string;
  apiBaseUrl: string;
  chatApiBaseUrl: string;
  sandboxes: OpenPondSandboxClient;
};

export class OpenPondWorkClient {
  readonly #apiKey: string;
  readonly #apiBaseUrl: string;
  readonly #chatApiBaseUrl: string;
  readonly #sandboxes: OpenPondSandboxClient;

  constructor(input: WorkClientInput) {
    this.#apiKey = input.apiKey;
    this.#apiBaseUrl = input.apiBaseUrl;
    this.#chatApiBaseUrl = input.chatApiBaseUrl;
    this.#sandboxes = input.sandboxes;
  }

  async run(input: OpenPondWorkRunInput): Promise<OpenPondWorkRunResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Work prompt is required");
    input.signal?.throwIfAborted();

    const emit = async (event: OpenPondWorkEvent) => input.onEvent?.(event);
    await emit({ type: "status", message: "Preparing sandbox" });
    const sandbox = await this.#resolveSandbox(input);
    if (sandbox.runtimeDriver === "simulated-firecracker" && !input.allowSimulated) {
      if (!input.sandboxId) {
        await this.#sandboxes.delete(sandbox.id, { async: true }).catch(() => undefined);
      }
      throw new Error(
        "OpenPond Work requires a remote-firecracker sandbox, but this environment returned the non-executing simulated-firecracker driver.",
      );
    }
    await emit({
      type: "sandbox",
      sandboxId: sandbox.id,
      state: sandbox.state,
      runtimeDriver: sandbox.runtimeDriver,
    });
    const messages: HostedChatMessage[] = [
      { role: "system", content: systemPrompt(sandbox.id) },
      ...(input.history ?? []).map((message) => ({ ...message })),
      { role: "user", content: prompt },
    ];
    const maxSteps = boundedInteger(input.maxSteps, 1, 100, DEFAULT_MAX_STEPS);
    let finalText = "";

    for (let step = 1; step <= maxSteps; step += 1) {
      input.signal?.throwIfAborted();
      await emit({ type: "status", message: `Thinking · step ${step}` });
      const completion = await sendHostedChatTurn({
        apiBaseUrl: this.#chatApiBaseUrl,
        token: this.#apiKey,
        model: input.model?.trim() || DEFAULT_MODEL,
        messages,
        tools: WORK_TOOLS,
        toolChoice: "auto",
        signal: input.signal,
        metadata: {
          source: "openpond-sdk-work",
          sandboxId: sandbox.id,
          apiBaseUrl: this.#apiBaseUrl,
          ...input.metadata,
        },
      });
      const choice = completion.choices?.[0];
      const assistantText = choice?.message?.content?.trim() ?? "";
      const toolCalls = choice?.message?.tool_calls ?? [];
      messages.push({
        role: "assistant",
        content: assistantText || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      if (assistantText) {
        finalText = assistantText;
        await emit({ type: "assistant", text: assistantText });
      }
      if (toolCalls.length === 0) {
        const result = { sandboxId: sandbox.id, text: finalText, steps: step };
        await emit({ type: "done", ...result });
        return result;
      }

      for (const [index, toolCall] of toolCalls.entries()) {
        const result = await this.#executeTool(
          sandbox.id,
          toolCall,
          index,
          input.timeoutSeconds,
          emit,
        );
        messages.push(result);
      }
    }

    throw new Error(`Work did not finish within ${maxSteps} steps`);
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.#sandboxes.get(sandboxId);
    if (sandbox.state === "deleted") return;
    await this.#sandboxes.delete(sandboxId, { async: true });
  }

  async #resolveSandbox(input: OpenPondWorkRunInput): Promise<SandboxRecord> {
    if (input.sandboxId) {
      const existing = await this.#sandboxes.get(input.sandboxId);
      if (existing.state === "stopped") {
        await this.#sandboxes.start(existing.id, { async: true });
      } else if (existing.state === "deleted" || existing.state === "error") {
        throw new Error(`Cannot resume sandbox ${existing.id} in state ${existing.state}`);
      }
      const ready = await this.#waitUntilRunning(existing.id, input.signal);
      return ready;
    }

    const budgetUsd = input.budgetUsd?.trim() || "1.00";
    const created = await this.#sandboxes.create(
      {
        ...(input.repo?.trim() ? { repo: input.repo.trim() } : {}),
        runtimeProfileId: "openpond-work-v1",
        resources: { cpu: 2, memoryGb: 4, diskGb: 16 },
        budget: { maxUsd: budgetUsd },
        quotas: {
          maxSpendUsd: budgetUsd,
          maxDurationSeconds: 3600,
          idleTimeoutSeconds: 900,
          maxCommands: 200,
          maxOpenPorts: 4,
        },
        metadata: { source: "openpond-sdk-work", ...input.metadata },
      },
      { async: true },
    );
    return this.#waitUntilRunning(created.id, input.signal);
  }

  async #waitUntilRunning(sandboxId: string, signal?: AbortSignal): Promise<SandboxRecord> {
    const deadline = Date.now() + 12 * 60_000;
    let sandbox = await this.#sandboxes.get(sandboxId);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (sandbox.state === "running") return sandbox;
      if (sandbox.state === "error" || sandbox.state === "deleted") {
        throw new Error(
          `Sandbox ${sandbox.id} entered ${sandbox.state}${sandbox.logs.length ? `: ${sandbox.logs.join("\n")}` : ""}`,
        );
      }
      await sleep(2_000, signal);
      sandbox = await this.#sandboxes.get(sandboxId);
    }
    throw new Error(`Sandbox ${sandboxId} did not become ready before timeout`);
  }

  async #executeTool(
    sandboxId: string,
    toolCall: HostedChatToolCall,
    index: number,
    timeoutSeconds: number | undefined,
    emit: (event: OpenPondWorkEvent) => void | Promise<void>,
  ): Promise<HostedChatMessage> {
    const toolCallId = toolCall.id || `work_tool_${index}`;
    const name = toolCall.function?.name;
    if (name !== "run_command") {
      return toolMessage(toolCallId, { error: `Unknown tool: ${name ?? "missing"}` });
    }

    let args: { command?: unknown };
    try {
      args = JSON.parse(toolCall.function?.arguments || "{}") as { command?: unknown };
    } catch (error) {
      return toolMessage(toolCallId, { error: `Invalid tool arguments: ${errorMessage(error)}` });
    }
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return toolMessage(toolCallId, { error: "command is required" });

    await emit({ type: "tool", toolCallId, command, status: "started" });
    try {
      const response = await this.#sandboxes.exec(sandboxId, {
        command,
        timeoutSeconds: boundedInteger(timeoutSeconds, 1, 900, 180),
      });
      const output = truncate(response.command.output, MAX_TOOL_OUTPUT_CHARS);
      if (isNonExecutingSandboxOutput(output)) {
        await emit({
          type: "tool",
          toolCallId,
          command,
          status: "failed",
          output: "Staging accepted the command but did not execute it.",
          exitCode: response.command.exitCode,
        });
        await this.#sandboxes.delete(sandboxId, { async: true }).catch(() => undefined);
        throw new OpenPondNonExecutingSandboxError(sandboxId);
      }
      const status = response.command.status === "succeeded" ? "succeeded" : "failed";
      await emit({
        type: "tool",
        toolCallId,
        command,
        status,
        output,
        exitCode: response.command.exitCode,
      });
      return toolMessage(toolCallId, {
        status: response.command.status,
        exitCode: response.command.exitCode,
        output,
      });
    } catch (error) {
      if (error instanceof OpenPondNonExecutingSandboxError) throw error;
      const output = errorMessage(error);
      await emit({ type: "tool", toolCallId, command, status: "failed", output });
      return toolMessage(toolCallId, { status: "failed", error: output });
    }
  }
}

const WORK_TOOLS: HostedChatTool[] = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command inside the persistent OpenPond sandbox. Use standard shell tools to inspect, edit, build, and test files. Commands start in the repository workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string", description: "Shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
];

function systemPrompt(sandboxId: string): string {
  return [
    "You are OpenPond Work, a careful coding agent operating in a persistent Linux sandbox.",
    `The active sandbox is ${sandboxId}.`,
    "Use run_command to inspect the workspace, edit files, and validate your work.",
    "Do the requested work completely. Preserve existing user changes and avoid destructive commands.",
    "Keep the user informed with concise prose, but call tools whenever verification or file changes are needed.",
    "Before finishing, run relevant tests and summarize the concrete result.",
  ].join("\n");
}

function toolMessage(toolCallId: string, payload: Record<string, unknown>): HostedChatMessage {
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(payload) };
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n… output truncated by openpond-sdk`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonExecutingSandboxOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("command accepted by simulated-firecracker driver") ||
    normalized.includes("no host command was executed")
  );
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
