import type { AcpObject } from "@openpond/agent-runtime";
import { ContextUsageSnapshotSchema } from "@openpond/contracts/settings";
import { type RuntimeEvent } from "@openpond/contracts/runtime";
import { type Session } from "@openpond/contracts/sessions";
import { event } from "../../utils.js";

function toolText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toolText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const part = value as AcpObject;
  if (typeof part.text === "string") return part.text;
  return part.content ? toolText(part.content) : "";
}

export function nativeAgentEvent(session: Session, turnId: string, update: AcpObject): RuntimeEvent | null {
  const base = { sessionId: session.id, turnId, appId: session.appId, source: "provider" as const };
  const content = update.content && typeof update.content === "object" ? update.content as AcpObject : {};
  const text = typeof content.text === "string" ? content.text : "";
  const nativeMessage = typeof update.messageId === "string"
    ? { nativeMessageId: `native-message:${turnId}:${update.messageId}:${update.sessionUpdate === "agent_thought_chunk" ? "thinking" : "text"}` }
    : {};
  switch (update.sessionUpdate) {
    case "agent_message_chunk": return event({ ...base, name: "assistant.delta", output: text, data: { ...update, ...nativeMessage, delta: text } });
    case "agent_message_final": return event({ ...base, name: "assistant.delta", output: text, data: { ...nativeMessage, phase: "final_answer", nativeMessageSnapshot: true } });
    case "agent_thought_chunk": return event({ ...base, name: "assistant.reasoning.delta", output: text, data: { ...update, ...nativeMessage, delta: text } });
    case "tool_call":
    case "tool_call_update": {
      const done = update.status === "completed" || update.status === "failed";
      const title = typeof update.title === "string" ? update.title : "native_tool";
      const input = update.rawInput && typeof update.rawInput === "object" ? update.rawInput as AcpObject : {};
      const result = toolText(update.content ?? update.rawOutput);
      const command = typeof input.command === "string" ? input.command : undefined;
      const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
      return event({ ...base, name: done ? "tool.completed" : "tool.started", action: title,
        args: input, status: update.status === "failed" ? "failed" : done ? "completed" : "started",
        output: done ? result : filePath ?? title, error: update.status === "failed" ? result || `${title} failed` : undefined,
        data: { ...update, nativeTool: true, callId: update.toolCallId, provider: session.provider, input, command, filePath, toolName: title } });
    }
    case "plan": return event({ ...base, name: "tool.completed", action: "update_plan", status: "completed", data: { ...update, plan: update.entries } });
    case "context_usage": {
      const parsed = ContextUsageSnapshotSchema.safeParse({ provider: session.provider, model: update.model,
        usedTokens: update.usedTokens, maxContextTokens: update.maxContextTokens, usableContextTokens: update.maxContextTokens,
        percentFull: Math.min(100, Number(update.usedTokens) / Number(update.maxContextTokens) * 100), source: "provider_usage", updatedAtEventId: null });
      if (!parsed.success) return null;
      const item = event({ ...base, name: "session.context.updated", data: parsed.data });
      item.data = { ...parsed.data, updatedAtEventId: item.id };
      return item;
    }
    case "compaction_started":
    case "compaction_completed":
    case "compaction_failed": return event({ ...base,
      name: update.sessionUpdate === "compaction_started" ? "session.compaction.started" : update.sessionUpdate === "compaction_completed" ? "session.compaction.completed" : "session.compaction.failed",
      error: typeof update.error === "string" ? update.error : undefined, data: { reason: update.reason, preTokens: update.preTokens, provider: session.provider } });
    case "usage_update": return event({ ...base, name: "diagnostic", action: "native_usage", data: update });
    case "current_mode_update":
    case "config_option_update":
    case "available_commands_update": return event({ ...base, name: "diagnostic", action: "native_configuration", data: update });
    default: return null;
  }
}
