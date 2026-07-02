import type { RuntimeEvent } from "@openpond/contracts";

const MAX_EVENT_STRING_CHARS = 120_000;
const MAX_LARGE_OUTPUT_CHARS = 32_000;
const LARGE_OUTPUT_HEAD_CHARS = 20_000;
const LARGE_OUTPUT_TAIL_CHARS = MAX_LARGE_OUTPUT_CHARS - LARGE_OUTPUT_HEAD_CHARS;
const MAX_EVENT_ARRAY_ITEMS = 100;
const MAX_EVENT_OBJECT_KEYS = 120;
const MAX_EVENT_DEPTH = 8;
const BASE64_CONTENT_KEYS = new Set([
  "contentsBase64",
  "contentBase64",
  "fileBase64",
  "bodyBase64",
]);
const LARGE_OUTPUT_EVENT_NAMES = new Set<RuntimeEvent["name"]>([
  "command.output",
  "tool.completed",
  "workspace_action_result",
]);

type RuntimeEventOutputCompaction = {
  schemaVersion: "openpond.runtimeEventOutputCompaction.v1";
  reason: "large_output";
  originalChars: number;
  retainedChars: number;
  omittedChars: number;
  headChars: number;
  tailChars: number;
};

export function sanitizeRuntimeEvent(runtimeEvent: RuntimeEvent): RuntimeEvent {
  return sanitizeEventValue(compactLargeRuntimeEventOutput(runtimeEvent), 0, "") as RuntimeEvent;
}

function compactLargeRuntimeEventOutput(runtimeEvent: RuntimeEvent): RuntimeEvent {
  if (
    !LARGE_OUTPUT_EVENT_NAMES.has(runtimeEvent.name) ||
    typeof runtimeEvent.output !== "string" ||
    hasOutputCompaction(runtimeEvent.data) ||
    runtimeEvent.output.length <= MAX_LARGE_OUTPUT_CHARS
  ) {
    return runtimeEvent;
  }

  const originalChars = runtimeEvent.output.length;
  const head = runtimeEvent.output.slice(0, LARGE_OUTPUT_HEAD_CHARS);
  const tail = runtimeEvent.output.slice(-LARGE_OUTPUT_TAIL_CHARS);
  const omittedChars = originalChars - head.length - tail.length;
  const marker = `\n[openpond event output compacted: ${omittedChars} chars omitted from ${originalChars} chars]\n`;
  const output = `${head}${marker}${tail}`;
  const compaction: RuntimeEventOutputCompaction = {
    schemaVersion: "openpond.runtimeEventOutputCompaction.v1",
    reason: "large_output",
    originalChars,
    retainedChars: output.length,
    omittedChars,
    headChars: head.length,
    tailChars: tail.length,
  };

  return {
    ...runtimeEvent,
    output,
    data: compactedEventData(runtimeEvent.data, compaction),
  };
}

function compactedEventData(
  data: RuntimeEvent["data"],
  outputCompaction: RuntimeEventOutputCompaction,
): RuntimeEvent["data"] {
  if (data === undefined) return { outputCompaction };
  if (isPlainRecord(data)) return { ...data, outputCompaction };
  return data;
}

function sanitizeEventValue(value: unknown, depth: number, key: string): unknown {
  if (typeof value === "string") return sanitizeEventString(value, key);
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_EVENT_DEPTH) return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  if (Array.isArray(value)) {
    const values = value
      .slice(0, MAX_EVENT_ARRAY_ITEMS)
      .map((item) => sanitizeEventValue(item, depth + 1, key));
    if (value.length > MAX_EVENT_ARRAY_ITEMS) {
      values.push(`[${value.length - MAX_EVENT_ARRAY_ITEMS} items truncated]`);
    }
    return values;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_EVENT_OBJECT_KEYS)
      .map(([childKey, child]) => [childKey, sanitizeEventValue(child, depth + 1, childKey)]),
  );
}

function sanitizeEventString(value: string, key: string): string {
  if (BASE64_CONTENT_KEYS.has(key)) {
    return `[redacted base64 content: ${estimatedBase64Bytes(value)} bytes]`;
  }
  if (value.length <= MAX_EVENT_STRING_CHARS) return value;
  return `${value.slice(0, MAX_EVENT_STRING_CHARS)}\n[event string truncated: ${value.length - MAX_EVENT_STRING_CHARS} chars omitted]`;
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOutputCompaction(data: RuntimeEvent["data"]): boolean {
  if (!isPlainRecord(data)) return false;
  const outputCompaction = data.outputCompaction;
  return isPlainRecord(outputCompaction) &&
    outputCompaction.schemaVersion === "openpond.runtimeEventOutputCompaction.v1";
}
