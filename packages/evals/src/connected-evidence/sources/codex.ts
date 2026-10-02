import { contentHash } from "@openpond/harness";
import type { ConnectedEvent, ConnectedFile } from "../contracts.js";
import { connectedTimestamp, event, json, normalizeConnectedSession, object } from "../normalize.js";
import { projectCodexAuthorization } from "./codex-authorization.js";
import { sourceUsage } from "./usage.js";

export function parseCodexSession(file: ConnectedFile, rows: Record<string, unknown>[]) {
  const metadata = object(rows.find(row => row.type === "session_meta")?.payload);
  if (typeof metadata.id !== "string") throw new Error("This is not a supported Codex rollout: session_meta.id is missing.");
  const events: ConnectedEvent[] = [];
  let turnId: string | null = null;
  let authorizationOmissions = 0;
  for (const [ordinal, row] of rows.entries()) {
    const projected = projectCodexAuthorization(row);
    authorizationOmissions += projected.omissions.length;
    const payload = object(projected.row.payload);
    if (row.type === "session_meta") continue;
    if (row.type === "turn_context") { turnId = typeof payload.turn_id === "string" ? payload.turn_id : turnId; continue; }
    const id = typeof payload.id === "string" ? payload.id : `codex-event-${contentHash([ordinal, row]).slice(0, 32)}`;
    const base = { id, occurredAt: connectedTimestamp(row.timestamp), parentId: turnId };
    if (row.type === "response_item") {
      if (payload.type === "message" && ["user", "assistant", "system", "developer"].includes(String(payload.role)))
        events.push(event({ ...base, kind: "message", role: payload.role === "developer" ? "system" : payload.role as "user" | "assistant" | "system", content: json(payload.content) }));
      else if (payload.type === "function_call" || payload.type === "custom_tool_call") events.push(event({ ...base, kind: "tool_call", callId: typeof payload.call_id === "string" ? payload.call_id : null, content: json(payload) }));
      else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") events.push(event({ ...base, kind: "tool_result", role: "tool", callId: typeof payload.call_id === "string" ? payload.call_id : null, content: json(payload.output) }));
      else events.push(event({ ...base, kind: "unknown", content: json(payload) }));
    } else if (row.type === "compacted") events.push(event({ ...base, kind: "compaction", content: json(payload) }));
    else if (row.type === "event_msg") {
      // These events mirror response_item messages. Keeping both doubles turns.
      if (["user_message", "agent_message", "agent_reasoning", "task_started"].includes(String(payload.type))) continue;
      if (payload.type === "task_complete" || payload.type === "turn_aborted") events.push(event({ ...base, kind: "terminal", content: { status: payload.type === "task_complete" ? "completed" : "cancelled", source: json(payload) } }));
      else if (payload.type === "token_count") {
        const info = object(payload.info);
        const usage = sourceUsage(info.total_token_usage, `codex-cumulative:${metadata.id}:${ordinal}`, "reported_cumulative");
        events.push(event({ ...base, kind: "usage", usage, content: json(payload) }));
      } else events.push(event({ ...base, kind: "unknown", content: json(payload) }));
    } else events.push(event({ ...base, kind: "unknown", content: json(projected.row) }));
  }
  return normalizeConnectedSession({ origin: "codex", sessionId: metadata.id, parentSessionId: typeof metadata.forked_from_id === "string" ? metadata.forked_from_id : null,
    exporterVersion: typeof metadata.cli_version === "string" ? metadata.cli_version : null, files: [file], events,
    warnings: ["Codex cumulative usage is retained as reported totals and is not summed as billed invocations.", "Referenced files are unavailable unless separately admitted.", ...(authorizationOmissions ? [`Codex native authorization state excluded by codex-native-authorization-v1 from ${authorizationOmissions} locations. Omission markers retain source-section hashes; sourceFiles retains original byte hashes. Other conversation evidence is unchanged and still requires privacy admission.`] : [])] });
}
