import {
  getOpChatModel,
  listOpChatModels,
  sendHostedChatTurn,
  streamHostedChatTurn,
  type HostedChatCompletion,
  type HostedChatToolCall,
  type HostedChatUsage,
} from "./hosted-chat.js";

export type OpChatSmokeOptions = {
  apiBaseUrl: string;
  token: string;
  defaultModel?: string;
  compatibilityModel?: string;
  invalidModel?: string;
  skipStream?: boolean;
  skipTool?: boolean;
  log?: (line: string) => void;
};

export type OpChatSmokeSummary = {
  apiBaseUrl: string;
  listedModels: string[];
  defaultModel: string;
  compatibilityModel: string;
  modelLookups: string[];
  invalidModelError: string;
  nonStreaming: OpChatCompletionSummary;
  compatibilityNonStreaming: OpChatCompletionSummary;
  streaming?: OpChatStreamSummary;
  toolCalling?: OpChatToolSummary;
};

export type OpChatCompletionSummary = {
  model: string;
  id: string | null;
  finishReason: string | null;
  textPreview: string;
  usage: HostedChatUsage | null;
};

export type OpChatStreamSummary = {
  model: string;
  textDeltaCount: number;
  textPreview: string;
  firstTextMs: number | null;
  totalMs: number;
  finishReason: string | null;
  usage: HostedChatUsage | null;
};

export type OpChatToolSummary = {
  model: string;
  toolCallCount: number;
  toolNames: string[];
  finishReason: string | null;
  followUp: OpChatCompletionSummary;
};

const DEFAULT_MODEL = "openpond-chat";
const COMPATIBILITY_MODEL = "deepseek-v4-flash";
const INVALID_MODEL = "not-a-real-opchat-model";

export async function runOpChatSmoke(
  options: OpChatSmokeOptions
): Promise<OpChatSmokeSummary> {
  const defaultModel = options.defaultModel || DEFAULT_MODEL;
  const compatibilityModel =
    options.compatibilityModel || COMPATIBILITY_MODEL;
  const invalidModel = options.invalidModel || INVALID_MODEL;
  const log = options.log || (() => undefined);

  log(`opchat base: ${options.apiBaseUrl}`);
  const models = await listOpChatModels({
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
  });
  const listedModels = models.data.map((model) => model.id);
  requireModel(listedModels, defaultModel);
  requireModel(listedModels, compatibilityModel);
  log(`models: ${listedModels.join(", ")}`);

  const defaultLookup = await getOpChatModel({
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    model: defaultModel,
  });
  const compatibilityLookup = await getOpChatModel({
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    model: compatibilityModel,
  });
  const invalidModelError = await expectInvalidModel({
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    model: invalidModel,
  });
  log(`invalid model error: ${invalidModelError}`);

  const nonStreaming = summarizeCompletion(
    defaultModel,
    await sendHostedChatTurn({
      apiBaseUrl: options.apiBaseUrl,
      token: options.token,
      model: defaultModel,
      messages: [
        {
          role: "user",
          content: "Reply with a short plain sentence confirming OpChat works.",
        },
      ],
      metadata: { source: "openpond-code-opchat-smoke", mode: "non_stream" },
    })
  );
  requireText(nonStreaming, `${defaultModel} non-streaming response`);
  log(
    `${defaultModel} non-stream: id=${nonStreaming.id ?? "unknown"} usage=${formatUsage(
      nonStreaming.usage
    )}`
  );

  const streaming = options.skipStream
    ? undefined
    : await runStreamSmoke({
        apiBaseUrl: options.apiBaseUrl,
        token: options.token,
        model: defaultModel,
      });
  if (streaming) {
    log(
      `${defaultModel} stream: chunks=${streaming.textDeltaCount} finish=${
        streaming.finishReason ?? "none"
      } usage=${formatUsage(streaming.usage)}`
    );
  }

  const compatibilityNonStreaming = summarizeCompletion(
    compatibilityModel,
    await sendHostedChatTurn({
      apiBaseUrl: options.apiBaseUrl,
      token: options.token,
      model: compatibilityModel,
      messages: [
        {
          role: "user",
          content: "Reply with one short sentence confirming compatibility.",
        },
      ],
      metadata: {
        source: "openpond-code-opchat-smoke",
        mode: "compatibility_non_stream",
      },
    })
  );
  requireText(
    compatibilityNonStreaming,
    `${compatibilityModel} non-streaming response`
  );
  log(
    `${compatibilityModel} non-stream: id=${
      compatibilityNonStreaming.id ?? "unknown"
    } usage=${formatUsage(compatibilityNonStreaming.usage)}`
  );

  const toolCalling = options.skipTool
    ? undefined
    : await runToolSmoke({
        apiBaseUrl: options.apiBaseUrl,
        token: options.token,
        model: defaultModel,
      });
  if (toolCalling) {
    log(
      `${defaultModel} tool: calls=${toolCalling.toolCallCount} names=${toolCalling.toolNames.join(
        ","
      )}`
    );
  }

  return {
    apiBaseUrl: options.apiBaseUrl,
    listedModels,
    defaultModel,
    compatibilityModel,
    modelLookups: [defaultLookup.id, compatibilityLookup.id],
    invalidModelError,
    nonStreaming,
    compatibilityNonStreaming,
    ...(streaming ? { streaming } : {}),
    ...(toolCalling ? { toolCalling } : {}),
  };
}

async function expectInvalidModel(options: {
  apiBaseUrl: string;
  token: string;
  model: string;
}): Promise<string> {
  try {
    await getOpChatModel(options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected invalid model ${options.model} to fail`);
}

async function runStreamSmoke(options: {
  apiBaseUrl: string;
  token: string;
  model: string;
}): Promise<OpChatStreamSummary> {
  const startedAt = Date.now();
  let firstTextAt: number | null = null;
  let text = "";
  let textDeltaCount = 0;
  let finishReason: string | null = null;
  let usage: HostedChatUsage | null = null;

  for await (const chunk of streamHostedChatTurn({
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    model: options.model,
    messages: [
      {
        role: "user",
        content: "Reply with a short streamed sentence.",
      },
    ],
    metadata: { source: "openpond-code-opchat-smoke", mode: "stream" },
  })) {
    if (chunk.type === "text_delta") {
      firstTextAt ??= Date.now();
      text += chunk.text;
      textDeltaCount += 1;
    } else if (chunk.type === "finish") {
      finishReason = chunk.finishReason;
    } else if (chunk.type === "usage") {
      usage = chunk.usage;
    }
  }

  if (textDeltaCount === 0 || !text.trim()) {
    throw new Error("streaming response did not emit text deltas");
  }
  if (!finishReason) {
    throw new Error("streaming response did not emit a terminal finish marker");
  }

  return {
    model: options.model,
    textDeltaCount,
    textPreview: previewText(text),
    firstTextMs: firstTextAt === null ? null : firstTextAt - startedAt,
    totalMs: Date.now() - startedAt,
    finishReason,
    usage,
  };
}

async function runToolSmoke(options: {
  apiBaseUrl: string;
  token: string;
  model: string;
}): Promise<OpChatToolSummary> {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_current_weather",
        description: "Get the current weather for a city.",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "City and region, for example Boston, MA.",
            },
          },
          required: ["location"],
        },
      },
    },
  ];
  const messages = [
    {
      role: "user" as const,
      content:
        "Use the get_current_weather tool for Boston, then wait for the result.",
    },
  ];
  const toolCompletion = await sendHostedChatTurn({
    apiBaseUrl: options.apiBaseUrl,
    token: options.token,
    model: options.model,
    messages,
    tools,
    toolChoice: "auto",
    metadata: { source: "openpond-code-opchat-smoke", mode: "tool_call" },
  });
  const choice = toolCompletion.choices?.[0];
  const toolCalls = choice?.message?.tool_calls ?? [];
  if (toolCalls.length === 0) {
    throw new Error("tool smoke did not receive an assistant tool call");
  }

  const toolResultMessages = buildToolResultMessages(toolCalls);
  const followUp = summarizeCompletion(
    options.model,
    await sendHostedChatTurn({
      apiBaseUrl: options.apiBaseUrl,
      token: options.token,
      model: options.model,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: choice?.message?.content ?? null,
          tool_calls: toolCalls,
        },
        ...toolResultMessages,
      ],
      metadata: { source: "openpond-code-opchat-smoke", mode: "tool_result" },
    })
  );
  requireText(followUp, "tool follow-up response");

  return {
    model: options.model,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls
      .map((toolCall) => toolCall.function?.name)
      .filter((name): name is string => Boolean(name)),
    finishReason: choice?.finish_reason ?? null,
    followUp,
  };
}

function buildToolResultMessages(toolCalls: HostedChatToolCall[]) {
  return toolCalls.map((toolCall, index) => {
    if (!toolCall.id) {
      throw new Error(`tool call ${index} is missing an id`);
    }
    return {
      role: "tool" as const,
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        location: "Boston, MA",
        temperature: "58 F",
        conditions: "clear",
      }),
    };
  });
}

function summarizeCompletion(
  model: string,
  completion: HostedChatCompletion
): OpChatCompletionSummary {
  const choice = completion.choices?.[0];
  return {
    model,
    id: completion.id ?? null,
    finishReason: choice?.finish_reason ?? null,
    textPreview: previewText(choice?.message?.content ?? ""),
    usage: completion.usage ?? null,
  };
}

function requireModel(models: string[], expected: string): void {
  if (!models.includes(expected)) {
    throw new Error(`model list did not include ${expected}`);
  }
}

function requireText(summary: OpChatCompletionSummary, label: string): void {
  if (!summary.textPreview.trim()) {
    throw new Error(`${label} did not include assistant text`);
  }
}

function previewText(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}...`;
}

function formatUsage(usage: HostedChatUsage | null): string {
  if (!usage) return "none";
  return String(
    usage.total_tokens ?? usage.input_tokens ?? usage.output_tokens ?? "unknown"
  );
}
