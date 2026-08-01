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
const WORK_INPUT_DIRECTORY = "/workspace/inputs/previous-outputs";
const WORK_INPUT_MANIFEST = "/workspace/inputs/.openpond-context.json";
const MAX_WORK_OUTPUTS = 100;
const MAX_WORK_INPUTS = 100;
const MAX_WORK_INPUT_BYTES = 100 * 1024 * 1024;

export type OpenPondWorkCleanup = "keep" | "stop" | "delete";

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

export type OpenPondWorkInputFile = {
  id: string;
  name: string;
  contentsBase64: string;
  mimeType?: string;
  checksumSha256?: string;
  revision?: number;
  metadata?: Record<string, unknown>;
};

export type OpenPondWorkOutputPersistenceContext = {
  output: OpenPondWorkOutput;
  /** Downloads and verifies the complete output at most once. */
  download: () => Promise<SandboxFileDownloadResponse>;
};

export type OpenPondWorkLifecycle = {
  cleanupPolicy: OpenPondWorkCleanup;
  persistence: {
    status: "not_requested" | "not_needed" | "running" | "complete" | "failed";
    outputCount: number;
    persistedCount: number;
    error?: string;
  };
  cleanup: {
    status: "not_requested" | "running" | "complete" | "pending" | "failed";
    finalSandboxState?: SandboxRecord["state"];
    error?: string;
  };
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
      type: "persistence";
      output: OpenPondWorkOutput;
      status: "started" | "succeeded" | "failed";
      error?: string;
    }
  | {
      type: "cleanup";
      policy: OpenPondWorkCleanup;
      status: "started" | "complete" | "pending" | "failed";
      sandboxState?: SandboxRecord["state"];
      error?: string;
    }
  | {
      type: "done";
      sandboxId: string;
      text: string;
      steps: number;
      outputs: OpenPondWorkOutput[];
      lifecycle: OpenPondWorkLifecycle;
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
  /** Defaults to keep for backwards compatibility. First-party Work callers use delete. */
  cleanup?: OpenPondWorkCleanup;
  /** Required before delete when a turn creates outputs, unless discardOutputs is true. */
  persistOutput?: (
    context: OpenPondWorkOutputPersistenceContext,
  ) => void | Promise<void>;
  /** Explicitly allows delete to discard detected outputs. */
  discardOutputs?: boolean;
  /** Durable outputs or other caller-owned files to stage into fresh compute. */
  inputs?: OpenPondWorkInputFile[];
  onEvent?: (event: OpenPondWorkEvent) => void | Promise<void>;
};

export type OpenPondWorkRunResult = {
  sandboxId: string;
  text: string;
  steps: number;
  outputs: OpenPondWorkOutput[];
  lifecycle: OpenPondWorkLifecycle;
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
    const cleanupPolicy = input.cleanup ?? "keep";
    const lifecycle = initialLifecycle(cleanupPolicy);
    let sandbox: SandboxRecord | null = null;
    let outputBaseline: Map<string, string> | null = null;
    let finalizationAttempted = false;
    const maxSteps = boundedInteger(input.maxSteps, 1, 100, DEFAULT_MAX_STEPS);
    let finalText = "";
    try {
      await emit({ type: "status", message: "Preparing sandbox" });
      sandbox = await this.#resolveSandbox(input);
      await emit({
        type: "sandbox",
        sandboxId: sandbox.id,
        state: sandbox.state,
      });
      await this.#stageInputs(sandbox.id, input.inputs ?? []);
      outputBaseline = await this.#prepareOutputDirectory(sandbox.id);
      const messages: HostedChatMessage[] = [
        {
          role: "system",
          content: systemPrompt(sandbox.id, (input.inputs?.length ?? 0) > 0),
        },
        ...(input.history ?? []).map((message) => ({ ...message })),
        { role: "user", content: prompt },
      ];

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
          finalizationAttempted = true;
          await this.#finalizeSandbox(sandbox.id, outputs, input, lifecycle, emit);
          const result = {
            sandboxId: sandbox.id,
            text: finalText,
            steps: step,
            outputs,
            lifecycle,
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
    } catch (error) {
      if (sandbox && outputBaseline && !finalizationAttempted) {
        try {
          const outputs = await this.#collectOutputs(sandbox.id, outputBaseline);
          for (const output of outputs) await emit({ type: "output", output });
          await this.#finalizeSandbox(sandbox.id, outputs, input, lifecycle, emit);
        } catch (finalizationError) {
          attachWorkFailure(error, lifecycle, finalizationError);
        }
      }
      attachWorkFailure(error, lifecycle);
      throw error;
    }
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.#sandboxes.get(sandboxId);
    if (sandbox.state === "deleted") return;
    await this.#sandboxes.delete(sandboxId);
  }

  async #stageInputs(
    sandboxId: string,
    inputs: OpenPondWorkInputFile[],
  ): Promise<void> {
    if (inputs.length === 0) return;
    if (inputs.length > MAX_WORK_INPUTS) {
      throw new Error(`Work inputs exceed the ${MAX_WORK_INPUTS} file limit`);
    }
    const decodedBytes = inputs.reduce(
      (total, input) => total + Buffer.byteLength(input.contentsBase64, "base64"),
      0,
    );
    if (decodedBytes > MAX_WORK_INPUT_BYTES) {
      throw new Error(`Work inputs exceed the ${MAX_WORK_INPUT_BYTES} byte limit`);
    }

    await this.#sandboxes.mkdir(sandboxId, {
      path: WORK_INPUT_DIRECTORY,
      recursive: true,
    });
    const usedNames = new Set<string>();
    const manifest = [];
    for (const [index, input] of inputs.entries()) {
      const name = uniqueInputName(input, index, usedNames);
      const stagedPath = `${WORK_INPUT_DIRECTORY}/${name}`;
      await this.#sandboxes.uploadFileBase64(
        sandboxId,
        stagedPath,
        input.contentsBase64,
      );
      manifest.push({
        id: input.id,
        path: stagedPath,
        name: input.name,
        mimeType: input.mimeType ?? null,
        checksumSha256: input.checksumSha256 ?? null,
        revision: input.revision ?? null,
        metadata: input.metadata ?? {},
      });
    }
    await this.#sandboxes.uploadFile(
      sandboxId,
      WORK_INPUT_MANIFEST,
      JSON.stringify({ version: 1, files: manifest }, null, 2),
    );
  }

  async #finalizeSandbox(
    sandboxId: string,
    outputs: OpenPondWorkOutput[],
    input: OpenPondWorkRunInput,
    lifecycle: OpenPondWorkLifecycle,
    emit: (event: OpenPondWorkEvent) => void | Promise<void>,
  ): Promise<void> {
    lifecycle.persistence.outputCount = outputs.length;
    if (outputs.length === 0) {
      lifecycle.persistence.status = "not_needed";
    } else if (input.persistOutput) {
      lifecycle.persistence.status = "running";
      for (const output of outputs) {
        await emit({ type: "persistence", output, status: "started" });
        try {
          const download = lazyOutputDownload(this.#sandboxes, sandboxId, output);
          await input.persistOutput({ output, download });
          lifecycle.persistence.persistedCount += 1;
          await emit({ type: "persistence", output, status: "succeeded" });
        } catch (error) {
          const message = errorMessage(error);
          lifecycle.persistence.status = "failed";
          lifecycle.persistence.error = message;
          await emit({
            type: "persistence",
            output,
            status: "failed",
            error: message,
          });
          if ((input.cleanup ?? "keep") !== "keep") {
            await this.#cleanupSandbox(sandboxId, "stop", lifecycle, emit);
          }
          throw error;
        }
      }
      lifecycle.persistence.status = "complete";
    } else if ((input.cleanup ?? "keep") === "delete" && !input.discardOutputs) {
      lifecycle.persistence.status = "failed";
      lifecycle.persistence.error =
        "Deleting a Work sandbox with outputs requires persistOutput or discardOutputs: true";
      await this.#cleanupSandbox(sandboxId, "stop", lifecycle, emit);
      throw new Error(lifecycle.persistence.error);
    } else {
      lifecycle.persistence.status = "not_requested";
    }

    await this.#cleanupSandbox(
      sandboxId,
      input.cleanup ?? "keep",
      lifecycle,
      emit,
    );
  }

  async #cleanupSandbox(
    sandboxId: string,
    policy: OpenPondWorkCleanup,
    lifecycle: OpenPondWorkLifecycle,
    emit: (event: OpenPondWorkEvent) => void | Promise<void>,
  ): Promise<void> {
    if (policy === "keep") return;
    lifecycle.cleanup.status = "running";
    await emit({ type: "cleanup", policy, status: "started" });
    try {
      const sandbox =
        policy === "delete"
          ? await this.#sandboxes.delete(sandboxId)
          : (await this.#sandboxes.stop(sandboxId)).sandbox;
      lifecycle.cleanup.finalSandboxState = sandbox.state;
      lifecycle.cleanup.status =
        (policy === "delete" && sandbox.state === "deleted") ||
        (policy === "stop" && sandbox.state === "stopped")
          ? "complete"
          : "pending";
      await emit({
        type: "cleanup",
        policy,
        status: lifecycle.cleanup.status,
        sandboxState: sandbox.state,
      });
    } catch (error) {
      const message = errorMessage(error);
      lifecycle.cleanup.status = "failed";
      lifecycle.cleanup.error = message;
      await emit({ type: "cleanup", policy, status: "failed", error: message });
      throw error;
    }
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

function systemPrompt(sandboxId: string, hasInputs: boolean): string {
  return [
    "You are OpenPond Work, a careful coding agent operating in an isolated Linux sandbox.",
    `The active sandbox is ${sandboxId}.`,
    ...(hasInputs
      ? [
          `Caller-provided durable files are staged under ${WORK_INPUT_DIRECTORY}; structured metadata is in ${WORK_INPUT_MANIFEST}.`,
        ]
      : []),
    "Use run_command to inspect the workspace, edit files, and validate your work.",
    `Place completed user-facing files in ${WORK_OUTPUT_DIRECTORY}. The runtime collects new and revised files there automatically when the turn completes.`,
    "Do the requested work completely. Preserve existing user changes and avoid destructive commands.",
    "Keep the user informed with concise prose, but call tools whenever verification or file changes are needed.",
    "Before finishing, run relevant tests and summarize the concrete result.",
  ].join("\n");
}

function initialLifecycle(
  cleanupPolicy: OpenPondWorkCleanup,
): OpenPondWorkLifecycle {
  return {
    cleanupPolicy,
    persistence: {
      status: "not_requested",
      outputCount: 0,
      persistedCount: 0,
    },
    cleanup: { status: "not_requested" },
  };
}

function lazyOutputDownload(
  sandboxes: OpenPondSandboxClient,
  sandboxId: string,
  output: OpenPondWorkOutput,
): () => Promise<SandboxFileDownloadResponse> {
  let pending: Promise<SandboxFileDownloadResponse> | null = null;
  return () => {
    pending ??= sandboxes
      .downloadFileResponse(sandboxId, {
        path: output.path,
        maxBytes: Math.max(1, output.sizeBytes),
      })
      .then((response) => {
        const decodedBytes = Buffer.byteLength(
          response.file.contentsBase64,
          "base64",
        );
        if (
          response.file.truncated ||
          response.file.returnedBytes !== response.file.totalSizeBytes ||
          decodedBytes !== output.sizeBytes
        ) {
          throw new Error(`Output download was incomplete for ${output.name}`);
        }
        return response;
      });
    return pending;
  };
}

function uniqueInputName(
  input: OpenPondWorkInputFile,
  index: number,
  usedNames: Set<string>,
): string {
  const safeId = input.id.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || `input-${index + 1}`;
  const safeName = input.name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "file";
  const base = `${safeId}-${safeName}`;
  let candidate = base;
  let collision = 1;
  while (usedNames.has(candidate)) {
    collision += 1;
    candidate = `${base}-${collision}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function attachWorkFailure(
  error: unknown,
  lifecycle: OpenPondWorkLifecycle,
  finalizationError?: unknown,
): void {
  if (!error || typeof error !== "object") return;
  Object.assign(error, {
    workLifecycle: lifecycle,
    ...(finalizationError
      ? { workFinalizationError: errorMessage(finalizationError) }
      : {}),
  });
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
