import type { HostedChatContinuation, HostedChatMessage, HostedChatToolCall } from "@openpond/cloud";

export type NativeModelToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
  hostedToolCall: HostedChatToolCall;
};

export type NativeModelToolResult = {
  toolCallId: string;
  name: string;
  ok: boolean;
  contentText: string;
  data?: unknown;
};

type AccumulatedToolCall = {
  key: string;
  index: number | null;
  id: string | null;
  type: string;
  name: string;
  argumentsJson: string;
};

export class NativeToolCallAccumulator {
  private readonly calls = new Map<string, AccumulatedToolCall>();

  append(toolCalls: HostedChatToolCall[]): void {
    toolCalls.forEach((toolCall, ordinal) => {
      const record = toolCall as Record<string, unknown>;
      const index = typeof record.index === "number" && Number.isInteger(record.index) ? record.index : null;
      const id = stringValue(toolCall.id);
      const key = index !== null ? `index:${index}` : id ? `id:${id}` : `ordinal:${ordinal}`;
      const current =
        this.calls.get(key) ??
        {
          key,
          index,
          id: null,
          type: "function",
          name: "",
          argumentsJson: "",
        };
      if (id) current.id = id;
      const type = stringValue(toolCall.type);
      if (type) current.type = type;
      const fn = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : {};
      const nameChunk = stringValue(fn.name);
      if (nameChunk) current.name += nameChunk;
      if (typeof fn.arguments === "string") current.argumentsJson += fn.arguments;
      this.calls.set(key, current);
    });
  }

  completed(): NativeModelToolCall[] {
    return [...this.calls.values()]
      .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER))
      .map((call, sequence) => completedToolCall(call, sequence))
      .filter((call): call is NativeModelToolCall => Boolean(call));
  }
}

export function assistantMessageForNativeToolCalls(
  content: string,
  toolCalls: NativeModelToolCall[],
  options: { continuation?: HostedChatContinuation | null } = {},
): HostedChatMessage {
  const continuation = options.continuation;
  return {
    role: "assistant",
    content: content.trim() || (continuation ? "" : null),
    ...(continuation ? { continuation } : {}),
    tool_calls: toolCalls.map((toolCall) => toolCall.hostedToolCall),
  };
}

export function toolResultMessage(result: NativeModelToolResult): HostedChatMessage {
  return {
    role: "tool",
    tool_call_id: result.toolCallId,
    content: result.contentText,
  };
}

export function parseNativeToolArguments(call: NativeModelToolCall): Record<string, unknown> {
  const raw = call.argumentsJson.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function invalidNativeToolArgumentsResult(
  call: NativeModelToolCall,
  message: string,
): NativeModelToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    ok: false,
    contentText: JSON.stringify(
      {
        ok: false,
        action: call.name,
        output: `Invalid ${call.name} tool arguments: ${message}`,
        repairHint: "Retry the tool call with arguments as one valid JSON object.",
      },
      null,
      2,
    ),
    data: {
      validationError: true,
      argumentsJson: call.argumentsJson,
    },
  };
}

export function unknownNativeToolResult(call: NativeModelToolCall): NativeModelToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    ok: false,
    contentText: JSON.stringify(
      {
        ok: false,
        action: call.name,
        output: `Unknown tool: ${call.name}`,
        repairHint: "Call one of the tools that was provided in this request.",
      },
      null,
      2,
    ),
  };
}

function completedToolCall(call: AccumulatedToolCall, sequence: number): NativeModelToolCall | null {
  const name = call.name.trim();
  if (!name) return null;
  const id = call.id ?? `call_${sequence + 1}`;
  const hostedToolCall: HostedChatToolCall = {
    id,
    type: call.type || "function",
    function: {
      name,
      arguments: call.argumentsJson,
    },
  };
  if (call.index !== null) {
    (hostedToolCall as Record<string, unknown>).index = call.index;
  }
  return {
    id,
    name,
    argumentsJson: call.argumentsJson,
    hostedToolCall,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
