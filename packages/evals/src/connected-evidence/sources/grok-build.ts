import type { ConnectedEvent, ConnectedFile } from "../contracts.js";
import {
  connectedTimestamp,
  event,
  json,
  normalizeConnectedSession,
  object,
} from "../normalize.js";
import { sourceUsage } from "./usage.js";
/** Retained ACP updates are native Grok history; Markdown exports are not accepted. */
export function parseGrokBuildSession(
  file: ConnectedFile,
  rows: Record<string, unknown>[],
) {
  const sessions = new Set(
    rows
      .map((row) => object(row.params).sessionId)
      .filter((value) => typeof value === "string"),
  );
  if (sessions.size !== 1)
    throw new Error(
      "Grok Build updates must identify exactly one retained session.",
    );
  const events: ConnectedEvent[] = [],
    ids = new Set<string>(),
    calls = new Map<string, ConnectedEvent>();
  let user: ConnectedEvent | null = null,
    answer: ConnectedEvent | null = null,
    completed = true;
  for (const row of rows) {
    const params = object(row.params),
      update = object(params.update),
      metadata = object(params._meta),
      kind = update.sessionUpdate;
    if (typeof metadata.eventId !== "string" || ids.has(metadata.eventId))
      throw new Error("Grok Build updates require unique native event IDs.");
    ids.add(metadata.eventId);
    const id = metadata.eventId,
      time = connectedTimestamp(
        metadata.agentTimestampMs ??
          (typeof row.timestamp === "number" ? row.timestamp * 1000 : null),
      );
    const content = object(update.content);
    if (kind === "user_message_chunk") {
      if (content.type !== "text" || typeof content.text !== "string")
        throw new Error("Grok user content type requires a qualified adapter.");
      if (!user || completed) {
        user = event({
          id,
          kind: "message",
          role: "user",
          occurredAt: time,
          content: content.text,
        });
        events.push(user);
        answer = null;
        completed = false;
      } else user.content = String(user.content) + content.text;
    } else if (kind === "agent_message_chunk") {
      if (content.type !== "text" || typeof content.text !== "string") {
        events.push(
          event({
            id,
            kind: "unknown",
            occurredAt: time,
            content: json(update),
          }),
        );
        continue;
      }
      if (!answer) {
        answer = event({
          id,
          kind: "message",
          role: "assistant",
          occurredAt: time,
          content: content.text,
        });
        events.push(answer);
      } else answer.content = String(answer.content) + content.text;
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const callId =
        typeof update.toolCallId === "string" ? update.toolCallId : null;
      if (!callId) {
        events.push(
          event({
            id,
            kind: "unknown",
            occurredAt: time,
            content: json(update),
          }),
        );
        continue;
      }
      let call = calls.get(callId);
      if (!call) {
        call = event({
          id: `${id}:call`,
          kind: "tool_call",
          callId,
          occurredAt: time,
          content: json({ title: update.title, input: update.rawInput }),
        });
        calls.set(callId, call);
        events.push(call);
      } else if (update.rawInput !== undefined)
        call.content = json({ title: update.title, input: update.rawInput });
      if (update.status === "completed" || update.status === "failed")
        events.push(
          event({
            id: `${id}:result`,
            kind: "tool_result",
            role: "tool",
            callId,
            occurredAt: time,
            content: json({
              status: update.status,
              output: update.rawOutput,
              content: update.content,
            }),
          }),
        );
    } else if (kind === "turn_completed") {
      const usage = object(update.usage),
        invocationId =
          typeof update.prompt_id === "string" ? update.prompt_id : id;
      events.push(
        event({
          id,
          kind: "terminal",
          occurredAt: time,
          content: {
            status:
              update.stop_reason === "end_turn"
                ? "completed"
                : update.stop_reason === "cancelled"
                  ? "cancelled"
                  : "failed",
          },
          usage: sourceUsage(
            {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cached_input_tokens: usage.cachedReadTokens,
              total_tokens: usage.totalTokens,
            },
            invocationId,
          ),
        }),
      );
      completed = true;
      answer = null;
      user = null;
    } else if (kind !== "agent_thought_chunk")
      events.push(
        event({ id, kind: "unknown", occurredAt: time, content: json(update) }),
      );
  }
  return normalizeConnectedSession({
    origin: "grok_build",
    sessionId: String([...sessions][0]),
    files: [file],
    events,
    contextComplete: false,
    warnings: [
      "Grok retained ACP updates omit system context and encrypted reasoning. Tool coverage reflects only logged updates.",
    ],
  });
}
