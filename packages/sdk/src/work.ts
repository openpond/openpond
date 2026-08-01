import { OpenPondApiError } from "../../cloud/src/api/core.js";
import {
  sendHostedChatTurn,
  type HostedChatMessage,
  type HostedChatTool,
  type HostedChatToolCall,
} from "../../cloud/src/hosted-chat.js";
import type { OpenPondSandboxClient } from "../../cloud/src/sandbox/client.js";
import type {
  SandboxFileDownloadResponse,
  SandboxFileEntry,
  SandboxRecord,
} from "../../cloud/src/sandbox/types/index.js";

const DEFAULT_MODEL = "openpond-chat";
const DEFAULT_MAX_STEPS = 24;
const MAX_TOOL_OUTPUT_CHARS = 40_000;
const WORK_OUTPUT_DIRECTORY = "/workspace/outputs";
const MAX_WORK_OUTPUTS = 100;

export type OpenPondWorkHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OpenPondWorkOutput = {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  isBinary: boolean | null;
  previewable: boolean;
};

export type OpenPondWorkEvent =
  | { type: "status"; message: string }
  | {
      type: "sandbox";
      sandboxId: string;
      state: SandboxRecord["state"];
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
  | { type: "output"; output: OpenPondWorkOutput }
  | {
      type: "done";
      sandboxId: string;
      text: string;
      steps: number;
      outputs: OpenPondWorkOutput[];
    };

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
  timeoutSeconds?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  onEvent?: (event: OpenPondWorkEvent) => void | Promise<void>;
};

export type OpenPondWorkRunResult = {
  sandboxId: string;
  text: string;
  steps: number;
  outputs: OpenPondWorkOutput[];
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
    await emit({
      type: "sandbox",
      sandboxId: sandbox.id,
      state: sandbox.state,
    });
    const outputBaseline = await this.#prepareOutputDirectory(sandbox.id);
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
        const outputs = await this.#collectOutputs(sandbox.id, outputBaseline);
        for (const output of outputs) await emit({ type: "output", output });
        const result = {
          sandboxId: sandbox.id,
          text: finalText,
          steps: step,
          outputs,
        };
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

  downloadOutput(
    sandboxId: string,
    output: OpenPondWorkOutput | string,
  ): Promise<SandboxFileDownloadResponse> {
    return this.#sandboxes.downloadFileResponse(
      sandboxId,
      typeof output === "string" ? output : output.path,
    );
  }

  async #prepareOutputDirectory(sandboxId: string): Promise<Map<string, string>> {
    await this.#sandboxes.mkdir(sandboxId, {
      path: WORK_OUTPUT_DIRECTORY,
      recursive: true,
    });
    return outputSignatures(await this.#listOutputFiles(sandboxId));
  }

  async #collectOutputs(
    sandboxId: string,
    baseline: Map<string, string>,
  ): Promise<OpenPondWorkOutput[]> {
    const files = await this.#listOutputFiles(sandboxId);
    return files
      .filter((file) => baseline.get(file.path) !== outputSignature(file))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, MAX_WORK_OUTPUTS)
      .map(workOutputFromFile);
  }

  async #listOutputFiles(sandboxId: string): Promise<SandboxFileEntry[]> {
    const listed = await this.#sandboxes.listFiles(sandboxId, {
      path: WORK_OUTPUT_DIRECTORY,
      recursive: true,
      maxEntries: 500,
    });
    return listed.files.filter(
      (file) =>
        file.type === "file" &&
        !normalizedOutputPath(file.path).includes("/.openpond-"),
    );
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
      if (error instanceof OpenPondApiError) throw error;
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
    `Place completed user-facing files in ${WORK_OUTPUT_DIRECTORY}. The runtime collects new and revised files there automatically when the turn completes.`,
    "Do the requested work completely. Preserve existing user changes and avoid destructive commands.",
    "Keep the user informed with concise prose, but call tools whenever verification or file changes are needed.",
    "Before finishing, run relevant tests and summarize the concrete result.",
  ].join("\n");
}

function outputSignatures(files: SandboxFileEntry[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, outputSignature(file)]));
}

function outputSignature(file: SandboxFileEntry): string {
  return `${file.sizeBytes}:${file.updatedAt}`;
}

function workOutputFromFile(file: SandboxFileEntry): OpenPondWorkOutput {
  const name = normalizedOutputPath(file.path).split("/").at(-1) || file.path;
  const mimeType = workOutputMimeType(name);
  return {
    path: file.path,
    name,
    mimeType,
    sizeBytes: file.sizeBytes,
    updatedAt: file.updatedAt,
    isBinary: file.isBinary ?? null,
    previewable:
      file.previewable ??
      (mimeType.startsWith("image/") ||
        mimeType === "application/pdf" ||
        mimeType.startsWith("text/")),
  };
}

function normalizedOutputPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function workOutputMimeType(name: string): string {
  const extension = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return WORK_OUTPUT_MIME_TYPES[extension] ?? "application/octet-stream";
}

const WORK_OUTPUT_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".avif": "image/avif",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

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
