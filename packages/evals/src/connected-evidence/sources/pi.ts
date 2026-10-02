import type { ConnectedEvent, ConnectedFile } from "../contracts.js";
import {
  connectedTimestamp,
  event,
  json,
  normalizeConnectedSession,
  object,
} from "../normalize.js";
import { sourceUsage } from "./usage.js";

/** Pi and OMP share a versioned tree container, but remain distinct source identities. */
export function parsePiSession(
  file: ConnectedFile,
  rows: Record<string, unknown>[],
  origin: "pi" | "oh_my_pi",
  selectedLeaf?: string,
) {
  const headers = rows.filter((row) => row.type === "session");
  const header = headers[0];
  if (
    headers.length !== 1 ||
    !header ||
    header.version !== 3 ||
    typeof header.id !== "string"
  )
    throw new Error("Expected a version 3 Pi session tree.");
  const entries = rows.filter(
    (row) => row.type !== "session" && row.type !== "title",
  );
  const nodes = new Map<string, Record<string, unknown>>();
  const parents = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || nodes.has(entry.id))
      throw new Error(
        "Session tree has missing or duplicate entry identities.",
      );
    nodes.set(entry.id, entry);
    if (typeof entry.parentId === "string") parents.add(entry.parentId);
  }
  const leaves = [...nodes.keys()].filter((id) => !parents.has(id));
  if (!selectedLeaf && leaves.length !== 1)
    throw new Error("Select a branch leaf for this branched session.");
  const leaf = selectedLeaf ?? leaves[0];
  if (!leaf || !nodes.has(leaf))
    throw new Error("The selected session branch is unavailable.");
  const branch: Record<string, unknown>[] = [],
    visited = new Set<string>();
  let current: string | null = leaf;
  while (current) {
    if (visited.has(current))
      throw new Error("Session branch contains a cycle.");
    visited.add(current);
    const entry = nodes.get(current);
    if (!entry) throw new Error("Session branch has a missing ancestor.");
    branch.push(entry);
    current = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  branch.reverse();
  const events: ConnectedEvent[] = [];
  for (const row of branch) {
    const id = String(row.id),
      base = {
        occurredAt: connectedTimestamp(row.timestamp),
        parentId: typeof row.parentId === "string" ? row.parentId : null,
      };
    if (row.type === "compaction" || row.type === "branch_summary") {
      events.push(
        event({
          ...base,
          id,
          kind: "compaction",
          content: json({
            summary: row.summary,
            firstKeptEntryId: row.firstKeptEntryId,
          }),
        }),
      );
      continue;
    }
    if (row.type !== "message") continue; // Configuration/credential bookkeeping is never conversation evidence.
    const message = object(row.message),
      role = message.role;
    if (role === "toolResult") {
      events.push(
        event({
          ...base,
          id,
          kind: "tool_result",
          role: "tool",
          callId:
            typeof message.toolCallId === "string" ? message.toolCallId : null,
          content: json({
            content: message.content,
            isError: message.isError === true,
          }),
        }),
      );
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "system") {
      events.push(
        event({
          ...base,
          id,
          kind: "unknown",
          content: json({ role, content: message.content }),
        }),
      );
      continue;
    }
    const blocks = Array.isArray(message.content)
      ? message.content.map(object)
      : [];
    const text =
      typeof message.content === "string"
        ? message.content
        : blocks
            .filter((block) => block.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("\n");
    const usage = object(message.usage);
    const normalizedUsage = sourceUsage(
      {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cached_input_tokens: usage.cacheRead,
        total_tokens: usage.totalTokens,
      },
      id,
    );
    if (text || role !== "assistant")
      events.push(
        event({
          ...base,
          id,
          kind: "message",
          role,
          content:
            role === "system" && !text && message.sections
              ? json(message.sections)
              : text,
          usage: normalizedUsage,
        }),
      );
    else if (normalizedUsage)
      events.push(
        event({
          ...base,
          id: `${id}:usage`,
          kind: "usage",
          content: null,
          usage: normalizedUsage,
        }),
      );
    for (const [index, block] of blocks.entries()) {
      if (block.type === "toolCall")
        events.push(
          event({
            ...base,
            id: `${id}:call:${index}`,
            kind: "tool_call",
            callId: typeof block.id === "string" ? block.id : null,
            content: json({ name: block.name, arguments: block.arguments }),
          }),
        );
      else if (block.type !== "text" && block.type !== "thinking")
        events.push(
          event({
            ...base,
            id: `${id}:block:${index}`,
            kind: "unknown",
            content: json(block),
          }),
        );
    }
    if (
      role === "assistant" &&
      ["stop", "error", "aborted"].includes(String(message.stopReason))
    )
      events.push(
        event({
          ...base,
          id: `${id}:terminal`,
          kind: "terminal",
          content: {
            status:
              message.stopReason === "stop"
                ? "completed"
                : message.stopReason === "aborted"
                  ? "cancelled"
                  : "failed",
          },
        }),
      );
  }
  // A selected leaf is a cutoff; native request IDs preserve turn identity as the branch grows.
  return normalizeConnectedSession({
    origin,
    sessionId: header.id,
    branchId: null,
    files: [file],
    events,
    exporterVersion: `session-v${header.version}`,
    warnings: [
      "Only the selected branch is included. Private provider payloads and credential metadata are excluded.",
    ],
  });
}
