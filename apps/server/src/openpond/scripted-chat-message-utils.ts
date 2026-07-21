import type { HostedChatMessage } from "@openpond/cloud";

export function latestToolResult(
  messages: HostedChatMessage[],
  action: string,
): Record<string, unknown> | null {
  return latestToolResultForActions(messages, new Set([action]));
}

export function latestSubagentInspection(
  messages: HostedChatMessage[],
): Record<string, unknown> | null {
  return latestToolResultForActions(
    messages,
    new Set(["openpond_subagent_join", "openpond_subagent_status"]),
  );
}

export function subagentRunIdFromResult(
  result: Record<string, unknown> | null,
): string | null {
  return stringFromPath(result, ["runId"])
    ?? stringFromPath(result, ["id"])
    ?? stringFromPath(result, ["runs", "0", "runId"])
    ?? stringFromPath(result, ["data", "runId"])
    ?? stringFromPath(result, ["data", "id"])
    ?? stringFromPath(result, ["data", "runs", "0", "runId"]);
}

export function subagentStatusFromResult(
  result: Record<string, unknown> | null,
): string | null {
  return stringFromPath(result, ["status"])
    ?? stringFromPath(result, ["runs", "0", "status"])
    ?? stringFromPath(result, ["data", "status"])
    ?? stringFromPath(result, ["data", "runs", "0", "status"]);
}

export function toolResultCount(messages: HostedChatMessage[], action: string): number {
  return toolResults(messages, action).length;
}

export function latestToolResultAfterLatestLifecycleWake(
  messages: HostedChatMessage[],
  action: string,
): Record<string, unknown> | null {
  const wakeIndex = latestLifecycleWakeMessageIndex(messages);
  if (wakeIndex === -1) return null;
  for (let index = messages.length - 1; index > wakeIndex; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "tool" || !message.content) continue;
    const parsed = parseToolContent(message.content);
    if (parsed?.action === action) return parsed;
  }
  return null;
}

export function latestLifecycleWakeMessageIndex(messages: HostedChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("subagent lifecycle watcher found required child work")
    ) {
      return index;
    }
  }
  return -1;
}

export function hasExecCommandResult(messages: HostedChatMessage[], command: string): boolean {
  const expected = command.trim();
  return toolResults(messages, "exec_command").some((result) =>
    stringFromPath(result, ["data", "command"])?.trim() === expected
    || stringFromPath(result, ["data", "command", "command"])?.trim() === expected
  );
}

function latestToolResultForActions(
  messages: HostedChatMessage[],
  actions: Set<string>,
): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "tool" || !message.content) continue;
    const parsed = parseToolContent(message.content);
    if (typeof parsed?.action === "string" && actions.has(parsed.action)) return parsed;
  }
  return null;
}

export function toolResults(messages: HostedChatMessage[], action: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || !message.content) continue;
    const parsed = parseToolContent(message.content);
    if (parsed?.action === action) results.push(parsed);
  }
  return results;
}

function parseToolContent(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringFromPath(record: Record<string, unknown> | null, path: string[]): string | null {
  let current: unknown = record;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return null;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}
