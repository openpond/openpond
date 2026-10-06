import type { RuntimeEvent } from "@openpond/contracts";
import { asRecord } from "./chat-message-utils";

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.every(block => typeof asRecord(block)?.text === "string")
    ? value.map(block => asRecord(block)!.text).join("\n") : JSON.stringify(value);
  const record = asRecord(value);
  if (typeof record?.text === "string") return record.text;
  return value == null ? "" : JSON.stringify(value);
}

/** Project declared native tool shapes without rewriting their retained evidence. */
export function projectNativeHistoryTool(item: RuntimeEvent, toolNames: Map<string, string>): RuntimeEvent {
  const data = asRecord(item.data);
  if (!data?.retainedHistory || item.action !== "native_tool" || !["tool.started", "tool.completed"].includes(item.name)) return item;
  const content = asRecord(data.content) ?? {};
  const call = item.name === "tool.started";
  const callId = typeof data.callId === "string" ? data.callId : null;
  const action = call && typeof content.name === "string" ? content.name : (callId ? toolNames.get(callId) : undefined) ?? "native_tool";
  if (call && callId) toolNames.set(callId, action);
  let args = content.input ?? content.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { input: args }; } }
  const error = content.error || (content.is_error === true ? content.content : null);
  return {
    ...item, action,
    status: call ? "started" : error != null || content.status === "error" ? "failed" : "completed",
    ...(call ? { args: asRecord(args) ?? {} } : { output: display(content.output ?? content.content ?? data.content), ...(error != null ? { error: display(error) } : {}) }),
  };
}
