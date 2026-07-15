import type { TaskDataRecord, Taskset } from "./tasksets.js";

export type TrainingTaskSizing = {
  renderedTokens: number;
  maximumAssistantTargetTokens: number;
  assistantTargetCount: number;
};

const MESSAGE_TEMPLATE_TOKENS = 8;
const RECORD_TEMPLATE_TOKENS = 24;
const CONSERVATIVE_CHARS_PER_TOKEN = 2;

/**
 * Conservatively sizes the same typed-message projection used by the Python
 * worker. JSON-heavy tool trajectories tokenize much more densely than prose,
 * so the estimate intentionally uses two characters per token.
 */
export function estimateTrainingTaskSizing(task: TaskDataRecord): TrainingTaskSizing {
  const messages = normalizedTrainingMessages(task);
  if (messages.length) {
    const renderedTokens = RECORD_TEMPLATE_TOKENS + messages.reduce(
      (total, message) => total + MESSAGE_TEMPLATE_TOKENS + estimatedTokens(message.content),
      0,
    );
    const assistantTargets = messages
      .filter((message) => message.role === "assistant")
      .map((message) => MESSAGE_TEMPLATE_TOKENS + estimatedTokens(message.content));
    return {
      renderedTokens,
      maximumAssistantTargetTokens: Math.max(0, ...assistantTargets),
      assistantTargetCount: assistantTargets.length,
    };
  }

  const prompt = textInput(task.input);
  const expected = textOutput(task.expectedOutput);
  return {
    renderedTokens: RECORD_TEMPLATE_TOKENS + estimatedTokens(prompt) + estimatedTokens(expected),
    maximumAssistantTargetTokens: MESSAGE_TEMPLATE_TOKENS + estimatedTokens(expected),
    assistantTargetCount: expected ? 1 : 0,
  };
}

export function recommendedTrainingSequenceLength(
  taskset: Taskset,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const minimum = options.minimum ?? 64;
  const maximum = options.maximum ?? 4_096;
  const required = taskset.tasks
    .filter((task) => task.split === "train")
    .reduce((largest, task) => Math.max(largest, estimateTrainingTaskSizing(task).renderedTokens), 0);
  if (required <= minimum) return minimum;
  return Math.min(maximum, 2 ** Math.ceil(Math.log2(required)));
}

type NormalizedMessage = { role: "system" | "user" | "assistant"; content: string };

function normalizedTrainingMessages(task: TaskDataRecord): NormalizedMessage[] {
  const candidates = [
    ...messageArray(task.input.messages),
    ...messageArray(task.expectedOutput?.messages),
  ];
  const messages: NormalizedMessage[] = [];
  const callIds = new Map<string, string>();
  const canonicalCallId = (value: unknown) => {
    const raw = typeof value === "string" && value ? value : `missing_${callIds.size + 1}`;
    if (!callIds.has(raw)) callIds.set(raw, `call_${callIds.size + 1}`);
    return callIds.get(raw)!;
  };
  for (const item of candidates) {
    if (!isRecord(item)) continue;
    const role = item.role;
    const content = item.content;
    if (role === "tool") {
      messages.push({
        role: "user",
        content: stableJson({
          content: typeof content === "string" ? content : "",
          tool_call_id: canonicalCallId(item.tool_call_id),
          type: "tool_result",
        }),
      });
      continue;
    }
    if (role === "assistant" && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      for (const call of item.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        messages.push({
          role: "assistant",
          content: stableJson({
            arguments: parsedArguments(call.function.arguments),
            name: call.function.name ?? null,
            type: "tool_call",
          }),
        });
        canonicalCallId(call.id);
      }
      if (typeof content === "string" && content) messages.push({ role: "assistant", content });
      continue;
    }
    if ((role === "system" || role === "user" || role === "assistant") && typeof content === "string" && content) {
      messages.push({ role, content });
    }
  }
  return messages;
}

function messageArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parsedArguments(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return { malformed_arguments: value };
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function textInput(value: Record<string, unknown>): string {
  return typeof value.prompt === "string" ? value.prompt : stableJson(value);
}

function textOutput(value: Record<string, unknown> | null): string {
  if (!value) return "";
  return typeof value.text === "string" ? value.text : stableJson(value);
}

function estimatedTokens(value: string): number {
  return Math.ceil(value.length / CONSERVATIVE_CHARS_PER_TOKEN);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
