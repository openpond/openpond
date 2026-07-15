import { createHash } from "node:crypto";
import {
  CROSS_SYSTEM_LOCAL_TOOL_MAX_TURNS,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  CROSS_SYSTEM_TOOL_NAMES,
  crossSystemLocalToolSystemPrompt,
} from "@openpond/contracts";
import type { HostedChatMessage, HostedChatTool, HostedChatToolCall, HostedChatToolChoice } from "@openpond/cloud";

export const LOCAL_ADAPTER_MAX_TOOL_TURNS = CROSS_SYSTEM_LOCAL_TOOL_MAX_TURNS;
const MAX_GENERATED_ENVELOPE_BYTES = 100_000;

export class LocalAdapterToolProtocolError extends Error {
  constructor(readonly code: "malformed_envelope" | "unknown_tool" | "schema_violation" | "budget_exhausted", message: string) {
    super(message);
    this.name = "LocalAdapterToolProtocolError";
  }
}

export type LocalAdapterParsedOutput =
  | { type: "final"; content: string }
  | { type: "tool_call"; toolCall: HostedChatToolCall };

export function crossSystemToolsFromRequest(tools: HostedChatTool[] | undefined, toolChoice?: HostedChatToolChoice): HostedChatTool[] {
  if (toolChoice === "none") return [];
  const requested = new Map((tools ?? []).flatMap((tool) => tool.function?.name ? [[tool.function.name, tool]] : []));
  const complete = CROSS_SYSTEM_TOOL_NAMES.every((name) => requested.has(name));
  if (!complete) return [];
  return CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: structuredClone(definition.parameters) as Record<string, unknown>,
    },
  }));
}

export function serializeLocalAdapterMessages(input: {
  messages: HostedChatMessage[];
  tools: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
}): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  assertLocalAdapterToolBudget(input.messages);
  const output: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  const callNames = new Map<string, string>();
  for (const message of input.messages) {
    if (message.role === "tool") {
      const callId = message.tool_call_id?.trim();
      const name = callId ? callNames.get(callId) : null;
      if (!name) {
        throw new LocalAdapterToolProtocolError("malformed_envelope", "Local adapter history contains a tool result without a matching registered tool call.");
      }
      output.push({
        role: "user",
        content: JSON.stringify(canonicalToolResult(name, message.content)),
      });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        const name = call.function?.name?.trim() ?? "";
        output.push({
          role: "assistant",
          content: JSON.stringify({
            type: "tool_call",
            name: name || null,
            arguments: parseArgumentsForHistory(call.function?.arguments),
          }),
        });
        if (call.id?.trim() && name) callNames.set(call.id.trim(), name);
      }
      if (message.content?.trim()) output.push({ role: "assistant", content: message.content });
      continue;
    }
    if ((message.role === "system" || message.role === "user" || message.role === "assistant") && message.content) {
      output.push({ role: message.role, content: message.content });
    }
  }
  if (input.tools.length) output.unshift({ role: "system", content: localAdapterToolInstruction(input.tools, input.toolChoice) });
  return output;
}

export function parseLocalAdapterOutput(output: string, tools: HostedChatTool[]): LocalAdapterParsedOutput {
  if (Buffer.byteLength(output, "utf8") > MAX_GENERATED_ENVELOPE_BYTES) {
    throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model output exceeded the constrained envelope byte limit.");
  }
  const normalized = stripFence(output.trim());
  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    if (/^ANSWER\s*:/.test(normalized)) {
      return { type: "final", content: constrainedAnswerContent(normalized) };
    }
    if (/^\s*\{/.test(normalized) || /"type"\s*:\s*"tool_call"/.test(normalized)) {
      throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model emitted malformed tool-call JSON.");
    }
    throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model final output must use ANSWER: followed by one JSON object.");
  }
  if (!isRecord(value) || value.type !== "tool_call") {
    if (isRecord(value) && value.type === "final" && typeof value.content === "string") {
      return { type: "final", content: constrainedAnswerContent(value.content) };
    }
    throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model final output must use ANSWER: followed by one JSON object.");
  }
  if (typeof value.name !== "string" || !value.name.trim()) throw new LocalAdapterToolProtocolError("malformed_envelope", "Tool-call envelope requires a name.");
  const tool = tools.find((candidate) => candidate.function?.name === value.name);
  if (!tool?.function) throw new LocalAdapterToolProtocolError("unknown_tool", `Local model requested unregistered tool ${value.name}.`);
  if (!isRecord(value.arguments)) throw new LocalAdapterToolProtocolError("schema_violation", "Tool-call arguments must be one JSON object.");
  const issue = validateJsonSchema(value.arguments, tool.function.parameters ?? {}, "arguments");
  if (issue) throw new LocalAdapterToolProtocolError("schema_violation", issue);
  const id = typeof value.id === "string" && value.id.trim() ? value.id.slice(0, 240) : `call_${stableSuffix(value.name, value.arguments)}`;
  return {
    type: "tool_call",
    toolCall: {
      id,
      type: "function",
      function: { name: value.name, arguments: JSON.stringify(value.arguments) },
    },
  };
}

export function assertLocalAdapterToolBudget(messages: HostedChatMessage[]): void {
  const rounds = messages.reduce((count, message) => count + (message.role === "assistant" ? message.tool_calls?.length ?? 0 : 0), 0);
  if (rounds >= LOCAL_ADAPTER_MAX_TOOL_TURNS) {
    throw new LocalAdapterToolProtocolError("budget_exhausted", `Local adapter tool loop exhausted its ${LOCAL_ADAPTER_MAX_TOOL_TURNS}-turn budget.`);
  }
}

function localAdapterToolInstruction(tools: HostedChatTool[], toolChoice?: HostedChatToolChoice): string {
  const names = tools.map((tool) => tool.function?.name);
  if (names.length !== CROSS_SYSTEM_TOOL_NAMES.length || names.some((name, index) => name !== CROSS_SYSTEM_TOOL_NAMES[index])) {
    throw new LocalAdapterToolProtocolError("unknown_tool", "Local adapter tool serialization requires the exact Cross-System Operations tool contract.");
  }
  return crossSystemLocalToolSystemPrompt(toolChoice ?? "auto");
}

function validateJsonSchema(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((candidate) => isRecord(candidate) && !validateJsonSchema(value, candidate, path))
      ? null
      : `${path} does not match an allowed schema.`;
  }
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) return `${path} must be an object.`;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) return `${path}.${key} is required.`;
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (extra) return `${path}.${extra} is not allowed.`;
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) {
        const issue = validateJsonSchema(item, propertySchema, `${path}.${key}`);
        if (issue) return issue;
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} has too few items.`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} has too many items.`;
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return `${path} items must be unique.`;
    if (isRecord(schema.items)) for (let index = 0; index < value.length; index += 1) {
      const issue = validateJsonSchema(value[index], schema.items, `${path}[${index}]`);
      if (issue) return issue;
    }
  } else if (type === "string") {
    if (typeof value !== "string") return `${path} must be a string.`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is too short.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is too long.`;
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${path} must be an ISO date.`;
  } else if (type === "integer") {
    if (!Number.isInteger(value)) return `${path} must be an integer.`;
    if (typeof schema.minimum === "number" && Number(value) < schema.minimum) return `${path} is below its minimum.`;
    if (typeof schema.maximum === "number" && Number(value) > schema.maximum) return `${path} exceeds its maximum.`;
  } else if (type === "null" && value !== null) return `${path} must be null.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return `${path} is outside the allowed enum.`;
  return null;
}

function parseArgumentsForHistory(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try { return JSON.parse(value); } catch { return { malformed_arguments: value }; }
}

function canonicalToolResult(name: string, content: unknown): {
  type: "tool_result";
  name: string;
  ok: boolean;
  result: unknown;
  error: unknown;
} {
  const parsed = parseToolResultContent(content);
  if (!isRecord(parsed)) {
    return { type: "tool_result", name, ok: true, result: parsed, error: null };
  }
  const ok = typeof parsed.ok === "boolean" ? parsed.ok : true;
  const result = Object.hasOwn(parsed, "result")
    ? parsed.result
    : Object.hasOwn(parsed, "data")
      ? parsed.data
      : ok
        ? parsed
        : null;
  const error = Object.hasOwn(parsed, "error")
    ? parsed.error
    : ok
      ? null
      : typeof parsed.output === "string"
        ? parsed.output
        : "Tool execution failed.";
  return { type: "tool_result", name, ok, result, error };
}

function parseToolResultContent(value: unknown): unknown {
  if (typeof value !== "string") return value ?? "";
  try { return JSON.parse(value); } catch { return value; }
}

function constrainedAnswerContent(content: string): string {
  const match = /^ANSWER\s*:\s*/.exec(content.trim());
  if (!match) throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model final output must use ANSWER: followed by one JSON object.");
  const json = firstJsonObject(content.trim().slice(match[0].length));
  if (!json) throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model emitted malformed ANSWER JSON.");
  let value: unknown;
  try { value = JSON.parse(json); } catch {
    throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model emitted malformed ANSWER JSON.");
  }
  if (!isRecord(value)) throw new LocalAdapterToolProtocolError("malformed_envelope", "Local model ANSWER JSON must be one object.");
  return `ANSWER: ${JSON.stringify(value)}`;
}

function firstJsonObject(value: string): string | null {
  if (!value.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(0, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function stripFence(value: string): string { return value.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim(); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function stableSuffix(name: string, args: Record<string, unknown>): string { return createHash("sha256").update(`${name}:${JSON.stringify(args)}`).digest("hex").slice(0, 16); }
