import type { ConnectedEvent, ConnectedFile } from "../contracts.js";
import {
  connectedTimestamp,
  event,
  json,
  normalizeConnectedSession,
  object,
} from "../normalize.js";
import { sourceUsage } from "./usage.js";

export function parseOpenCodeSession(file: ConnectedFile, value: unknown) {
  const root = object(value),
    info = object(root.info);
  if (typeof info.id !== "string" || !Array.isArray(root.messages))
    throw new Error(
      "OpenCode requires its native JSON session export (info and messages).",
    );
  const events: ConnectedEvent[] = [];
  for (const raw of root.messages) {
    const item = object(raw),
      message = object(item.info),
      time = object(message.time);
    if (
      typeof message.id !== "string" ||
      message.sessionID !== info.id ||
      !Array.isArray(item.parts)
    )
      throw new Error("OpenCode message identity does not match its session.");
    const role = message.role;
    if (role !== "user" && role !== "assistant")
      throw new Error("Unsupported OpenCode message role.");
    const base = {
      occurredAt: connectedTimestamp(time.created),
      parentId: typeof message.parentID === "string" ? message.parentID : null,
    };
    const parts = item.parts.map(object);
    if (
      parts.some(
        (part) =>
          part.sessionID !== info.id ||
          part.messageID !== message.id ||
          typeof part.id !== "string",
      )
    )
      throw new Error("OpenCode part identity does not match its message.");
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
    const tokens = object(message.tokens),
      cache = object(tokens.cache);
    const usage = sourceUsage(
      {
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cached_input_tokens: cache.read,
        total_tokens: tokens.total,
      },
      message.id,
    );
    if (text || role === "user")
      events.push(
        event({
          ...base,
          id: message.id,
          kind: "message",
          role,
          content: text,
          usage,
        }),
      );
    else if (usage)
      events.push(
        event({
          ...base,
          id: `${message.id}:usage`,
          kind: "usage",
          content: null,
          usage,
        }),
      );
    for (const part of parts) {
      const id = String(part.id);
      if (part.type === "tool") {
        const state = object(part.state),
          callId = typeof part.callID === "string" ? part.callID : null;
        events.push(
          event({
            ...base,
            id: `${id}:call`,
            kind: "tool_call",
            callId,
            content: json({ name: part.tool, arguments: state.input }),
          }),
        );
        if (state.status === "completed" || state.status === "error")
          events.push(
            event({
              ...base,
              id: `${id}:result`,
              kind: "tool_result",
              role: "tool",
              callId,
              content: json({
                output: state.output,
                error: state.error,
                status: state.status,
              }),
            }),
          );
      } else if (part.type === "compaction")
        events.push(
          event({ ...base, id, kind: "compaction", content: json(part) }),
        );
      else if (
        !["text", "reasoning", "step-start", "step-finish"].includes(
          String(part.type),
        )
      )
        events.push(
          event({ ...base, id, kind: "unknown", content: json(part) }),
        );
    }
    if (role === "assistant" && (message.finish === "stop" || message.error))
      events.push(
        event({
          ...base,
          id: `${message.id}:terminal`,
          kind: "terminal",
          content: { status: message.error ? "failed" : "completed" },
        }),
      );
  }
  return normalizeConnectedSession({
    origin: "opencode",
    sessionId: info.id,
    parentSessionId: typeof info.parentID === "string" ? info.parentID : null,
    exporterVersion: typeof info.version === "string" ? info.version : null,
    files: [file],
    events,
    warnings: ["Source-reported usage is not an OpenPond billing receipt."],
  });
}
