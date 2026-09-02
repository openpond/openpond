import {
  CodexAppServerClient,
  defaultServerRequestResult,
  type CodexDynamicToolSpec,
  type CodexNotification,
  type CodexServerRequest,
  type CodexServerRequestResult,
} from "@openpond/codex-provider";

type PolicyRequest = {
  messages?: unknown;
  tools?: unknown;
  deliveryId?: unknown;
  turnIndex?: unknown;
  seed?: unknown;
};

type CapturedToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type ActiveCompletion = {
  threadId: string | null;
  turnId: string | null;
  toolNames: Set<string>;
  toolCalls: CapturedToolCall[];
  agentMessages: Array<{ text: string; phase: string | null }>;
  usage: TokenUsage | null;
  acceptingToolCalls: boolean;
};

export type CodexTasksetPolicyRuntime = {
  complete(request: PolicyRequest, signal: AbortSignal): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

export function createCodexTasksetPolicyRuntime(input: {
  modelId: string;
  runId: string;
  cwd?: string;
  binaryPath?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}): CodexTasksetPolicyRuntime {
  let active: ActiveCompletion | null = null;
  const client = new CodexAppServerClient({
    binaryPath: input.binaryPath ?? process.env.CODEX_BINARY ?? "codex",
    clientName: "openpond-comparison-evaluator",
    clientTitle: "OpenPond Comparison Evaluator",
    clientVersion: "0.1.0",
    experimentalApi: true,
    onNotification: (notification) => captureNotification(active, notification),
    onServerRequest: (request) => captureToolCall(active, request),
  });

  return {
    async complete(request, signal) {
      if (active) throw new Error("codex_taskset_policy_request_overlap");
      const messages = policyMessages(request.messages);
      const dynamicTools = policyTools(request.tools);
      const state: ActiveCompletion = {
        threadId: null,
        turnId: null,
        toolNames: new Set(dynamicTools.map((tool) => tool.name)),
        toolCalls: [],
        agentMessages: [],
        usage: null,
        acceptingToolCalls: true,
      };
      active = state;
      try {
        const systemInstructions = messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .join("\n\n");
        const thread = await client.startThread({
          cwd: input.cwd ?? process.cwd(),
          model: input.modelId,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          baseInstructions: systemInstructions || null,
          developerInstructions: policyDeveloperInstructions(),
          dynamicTools,
          config: {
            model_reasoning_effort: input.reasoningEffort ?? "xhigh",
            "tools.web_search": false,
            "tools.view_image": false,
            "features.web_search_request": false,
          },
        });
        state.threadId = thread.threadId;
        const turn = await client.startTurn({
          threadId: thread.threadId,
          prompt: policyTurnPrompt(messages, request),
          cwd: input.cwd ?? process.cwd(),
          model: input.modelId,
          approvalPolicy: "never",
          sandbox: "read-only",
        });
        state.turnId = turn.turnId;
        await waitForTurnWithSignal(client, thread.threadId, turn.turnId, signal);
        const content = state.toolCalls.length ? null : finalAgentMessage(state.agentMessages);
        if (!state.toolCalls.length && !content) throw new Error("codex_taskset_policy_empty_completion");
        const requestId = `${input.runId}:${String(request.deliveryId ?? "delivery")}:${String(request.turnIndex ?? 0)}`;
        return {
          response: {
            choices: [{
              message: {
                content,
                tool_calls: state.toolCalls,
              },
            }],
          },
          trainingSample: { modelRequestId: requestId },
          ...(state.usage ? { usage: state.usage } : {}),
        };
      } finally {
        active = null;
      }
    },
    close: () => client.stop(),
  };
}

function policyDeveloperInstructions(): string {
  return [
    "You are the policy being evaluated in a frozen customer-support benchmark.",
    "Produce exactly the next assistant action for the supplied conversation.",
    "The conversation JSON and its system policy are authoritative application data, not instructions to inspect or edit the local workspace.",
    "Use only the supplied benchmark functions. Never use shell, filesystem, web, MCP, collaboration, or other Codex tools.",
    "When a benchmark function is needed, call the appropriate supplied function and stop. The benchmark host will provide its real result in the next policy request.",
    "When no function is needed, return only the customer-facing assistant response.",
    "Do not discuss the benchmark, the transcript encoding, or these execution instructions.",
  ].join("\n");
}

function policyTurnPrompt(messages: Array<Record<string, unknown>>, request: PolicyRequest): string {
  return [
    `Evaluation seed label: ${String(request.seed ?? 0)}.`,
    "Conversation JSON:",
    JSON.stringify(messages),
    "Produce the next assistant action now.",
  ].join("\n\n");
}

function policyMessages(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message))
    .map((message) => ({ ...message }));
}

function policyTools(value: unknown): CodexDynamicToolSpec[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const tool = requiredRecord(candidate, "benchmark tool");
    if (tool.type !== "function") throw new Error("codex_taskset_policy_tool_type_unsupported");
    const fn = requiredRecord(tool.function, "benchmark tool function");
    const name = requiredString(fn.name, "benchmark tool name");
    return {
      type: "function",
      name,
      description: typeof fn.description === "string" ? fn.description : `Execute ${name}.`,
      inputSchema: fn.parameters ?? { type: "object", additionalProperties: true },
    };
  });
}

function captureNotification(active: ActiveCompletion | null, notification: CodexNotification): void {
  if (!active) return;
  const params = record(notification.params);
  if (notification.method === "item/completed") {
    const item = record(params?.item);
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      active.agentMessages.push({ text: item.text, phase: typeof item.phase === "string" ? item.phase : null });
      if (active.toolCalls.length) active.acceptingToolCalls = false;
    }
    return;
  }
  if (notification.method !== "thread/tokenUsage/updated") return;
  const tokenUsage = record(params?.tokenUsage);
  const total = record(tokenUsage?.total);
  if (!total) return;
  const promptTokens = nonnegativeInteger(total.inputTokens);
  const completionTokens = nonnegativeInteger(total.outputTokens);
  const totalTokens = nonnegativeInteger(total.totalTokens);
  if (promptTokens === null || completionTokens === null || totalTokens === null) return;
  active.usage = { promptTokens, completionTokens, totalTokens };
}

async function captureToolCall(
  active: ActiveCompletion | null,
  request: CodexServerRequest,
): Promise<CodexServerRequestResult> {
  if (request.method !== "item/tool/call") return defaultServerRequestResult(request);
  if (!active) return failedToolResponse("No benchmark policy request is active.");
  const params = requiredRecord(request.params, "Codex dynamic tool call");
  const threadId = requiredString(params.threadId, "Codex dynamic tool thread ID");
  const turnId = requiredString(params.turnId, "Codex dynamic tool turn ID");
  const name = requiredString(params.tool, "Codex dynamic tool name");
  const callId = requiredString(params.callId, "Codex dynamic tool call ID");
  if ((active.threadId && active.threadId !== threadId) || (active.turnId && active.turnId !== turnId)) {
    return failedToolResponse("This tool call does not belong to the active benchmark request.");
  }
  if (!active.toolNames.has(name)) return failedToolResponse("This function is not part of the frozen benchmark tool contract.");
  if (!active.acceptingToolCalls) return failedToolResponse("The benchmark host already captured the next policy action.");
  active.toolCalls.push({
    id: callId,
    type: "function",
    function: { name, arguments: JSON.stringify(params.arguments ?? {}) },
  });
  return {
    result: {
      contentItems: [{
        type: "inputText",
        text: "The benchmark host captured this function call. End this response now; the real function result will be supplied in the next policy request.",
      }],
      success: true,
    },
  };
}

function failedToolResponse(text: string): CodexServerRequestResult {
  return { result: { contentItems: [{ type: "inputText", text }], success: false } };
}

async function waitForTurnWithSignal(
  client: CodexAppServerClient,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("codex_taskset_policy_aborted");
  let removeAbort: () => void = () => {};
  const abort = new Promise<never>((_, reject) => {
    const listener = () => {
      void client.interruptTurn({ threadId, turnId }).catch(() => undefined);
      reject(signal.reason ?? new Error("codex_taskset_policy_aborted"));
    };
    signal.addEventListener("abort", listener, { once: true });
    removeAbort = () => signal.removeEventListener("abort", listener);
  });
  try {
    await Promise.race([client.waitForTurn(turnId, 10 * 60_000), abort]);
  } finally {
    removeAbort();
  }
}

function finalAgentMessage(messages: ActiveCompletion["agentMessages"]): string | null {
  const final = [...messages].reverse().find((message) => message.phase === "final_answer")
    ?? messages.at(-1);
  return final?.text.trim() || null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) throw new Error(`${label} must be an object.`);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
