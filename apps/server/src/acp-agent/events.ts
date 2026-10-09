import path from "node:path";
import type { JsonRpcNotification } from "@openpond/agent-runtime";
import type { RuntimeEvent } from "@openpond/contracts";
import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function runtimeEvent(notification: JsonRpcNotification): RuntimeEvent | null {
  const params = record(notification.params), data = record(params.data);
  if (typeof data.originalName !== "string" || typeof data.eventId !== "string") return null;
  return { id: data.eventId, sequence: params.sequence, name: data.originalName, sessionId: params.threadId, turnId: params.turnId,
    action: data.action, args: data.args, data: data.payload, output: params.output, error: params.error,
    source: params.source, status: params.status, timestamp: data.timestamp } as RuntimeEvent;
}

export function toolKind(name: string): ToolKind {
  if (/exec|command|terminal/.test(name)) return "execute";
  if (/write|edit|patch/.test(name)) return "edit";
  if (/delete|remove/.test(name)) return "delete";
  if (/search|find|list/.test(name)) return "search";
  if (/read|inspect|fetch/.test(name)) return "read";
  if (name === "ask_user") return "think";
  return "other";
}

/** All projection uses durable event/tool IDs, both during generation and replay. */
export function updatesForEvent(event: RuntimeEvent, cwd: string): SessionUpdate[] {
  const data = record(event.data);
  if (event.name === "user_question.asked") {
    const question = record(data.question), options = Array.isArray(question.options) ? question.options.map(record) : [];
    return [{ sessionUpdate: "agent_message_chunk", messageId: event.id, content: { type: "text", text: `${question.question}${options.length ? `\n${options.map(option => `${option.id}: ${option.label}`).join("\n")}` : ""}` } }];
  }
  if (event.name === "assistant.delta" || event.name === "assistant.reasoning.delta") {
    return event.output ? [{ sessionUpdate: event.name === "assistant.delta" ? "agent_message_chunk" : "agent_thought_chunk", messageId: `${event.turnId}:${event.name}`, content: { type: "text", text: event.output } }] : [];
  }
  if (event.name === "tool.started" || event.name === "tool.completed") {
    const id = typeof data.toolCallId === "string" ? data.toolCallId : event.id;
    const name = String(data.tool ?? event.action ?? "Tool");
    if (event.name === "tool.started") return [{ sessionUpdate: "tool_call", toolCallId: id, title: name, kind: toolKind(name), status: "in_progress", rawInput: event.args }];
    const updates: SessionUpdate[] = [{ sessionUpdate: "tool_call_update", toolCallId: id, status: event.status === "failed" ? "failed" : "completed", rawOutput: data.result ?? event.output,
      content: event.output ? [{ type: "content", content: { type: "text", text: event.output } }] : [] }];
    const result = record(data.result);
    if (name === "update_plan" && Array.isArray(result.plan)) {
      updates.push({ sessionUpdate: "plan", entries: result.plan.map(item => { const entry = record(item); return { content: String(entry.step ?? entry.content ?? ""), priority: "medium", status: entry.status === "completed" ? "completed" : entry.status === "in_progress" ? "in_progress" : "pending" }; }) });
    }
    return updates;
  }
  if (event.name === "workspace.diff") {
    const files = Array.isArray(data.files) ? data.files.map(record) : [];
    return [{ sessionUpdate: "tool_call", toolCallId: event.id, title: "Workspace changes", kind: "edit", status: "completed", rawOutput: data,
      locations: files.flatMap(file => typeof file.path === "string" ? [{ path: path.resolve(cwd, file.path) }] : []),
      content: [{ type: "content", content: { type: "text", text: files.map(file => String(file.patch ?? file.diff ?? file.path ?? "")).join("\n") || JSON.stringify(data) } }] }];
  }
  return [];
}
