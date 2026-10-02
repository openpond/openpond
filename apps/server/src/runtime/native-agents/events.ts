import type { AcpObject } from "@openpond/agent-runtime";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { event } from "../../utils.js";

export function nativeAgentEvent(session: Session, turnId: string, update: AcpObject): RuntimeEvent | null {
  const base = { sessionId: session.id, turnId, appId: session.appId, source: "provider" as const };
  const content = update.content && typeof update.content === "object" ? update.content as AcpObject : {};
  const text = typeof content.text === "string" ? content.text : "";
  switch (update.sessionUpdate) {
    case "agent_message_chunk": return event({ ...base, name: "assistant.delta", output: text, data: { ...update, delta: text } });
    case "agent_thought_chunk": return event({ ...base, name: "assistant.reasoning.delta", output: text, data: { ...update, delta: text } });
    case "tool_call":
    case "tool_call_update": {
      const done = update.status === "completed" || update.status === "failed";
      return event({ ...base, name: done ? "tool.completed" : "tool.started", action: String(update.kind ?? "native_tool"), status: update.status === "failed" ? "failed" : done ? "completed" : "started", output: typeof update.title === "string" ? update.title : undefined, data: { ...update, callId: update.toolCallId, provider: session.provider } });
    }
    case "plan": return event({ ...base, name: "tool.completed", action: "update_plan", status: "completed", data: { ...update, plan: update.entries } });
    case "usage_update": return event({ ...base, name: "diagnostic", action: "native_usage", data: update });
    case "current_mode_update":
    case "config_option_update":
    case "available_commands_update": return event({ ...base, name: "diagnostic", action: "native_configuration", data: update });
    default: return null;
  }
}
