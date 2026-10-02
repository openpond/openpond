import { contentHash } from "@openpond/harness";
import type { ConnectedEvent, ConnectedFile } from "../contracts.js";
import { connectedTimestamp, event, json, normalizeConnectedSession, object } from "../normalize.js";
import { sourceUsage } from "./usage.js";

export function parseClaudeSession(file: ConnectedFile, rows: Record<string, unknown>[], leafId?: string) {
  const messages = rows.filter(row => (row.type === "user" || row.type === "assistant") && typeof row.uuid === "string");
  const sessionIds = new Set(messages.flatMap(row => typeof row.sessionId === "string" ? [row.sessionId] : []));
  if (sessionIds.size !== 1 || !messages.length) throw new Error("A supported Claude Code transcript must identify one session with UUID messages.");
  const nodes = rows.filter(row => typeof row.uuid === "string" && row.sessionId === [...sessionIds][0]);
  const byId = new Map(nodes.map(row => [row.uuid as string, row]));
  if (byId.size !== nodes.length) throw new Error("Claude Code transcript contains duplicate message UUIDs.");
  const parents = new Set(nodes.flatMap(row => typeof row.parentUuid === "string" ? [row.parentUuid] : []));
  const leaves = nodes.filter(row => !parents.has(row.uuid as string));
  if (!leafId && leaves.length !== 1) throw new Error("This transcript has multiple branches. Select a branch leaf UUID before importing.");
  let current = byId.get(leafId ?? leaves[0]!.uuid as string);
  if (!current) throw new Error("The selected Claude Code branch leaf is missing.");
  const chain: Record<string, unknown>[] = [], seen = new Set<string>();
  let missingParent = false;
  while (current) {
    const id = current.uuid as string;
    if (seen.has(id)) throw new Error("Claude Code branch contains a parent cycle.");
    seen.add(id); chain.unshift(current);
    const parent = current.parentUuid;
    if (typeof parent !== "string") break;
    current = byId.get(parent); if (!current) missingParent = true;
  }
  const events: ConnectedEvent[] = [];
  for (const row of chain) {
    if (row.type !== "user" && row.type !== "assistant") continue;
    const message = object(row.message), content = message.content;
    const base = { occurredAt: connectedTimestamp(row.timestamp), parentId: typeof row.parentUuid === "string" ? row.parentUuid : null };
    const role = row.type === "user" ? "user" : "assistant";
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
    const textBlocks = blocks.filter(block => object(block).type === "text");
    // User tool_result messages are process evidence, not independent requests.
    if (textBlocks.length) events.push(event({ ...base, id: row.uuid as string, kind: "message", role, content: json(textBlocks) }));
    if (role === "assistant" && message.usage) events.push(event({ ...base, id: `${row.uuid}:usage`, kind: "usage", content: json(message.usage),
      usage: sourceUsage(message.usage, typeof message.id === "string" ? message.id : row.uuid as string) }));
    for (const [index, value] of blocks.entries()) {
      const block = object(value);
      if (block.type === "text" || block.type === "thinking" || block.type === "redacted_thinking") continue;
      const id = `${row.uuid}:${index}`;
      if (block.type === "tool_use") events.push(event({ ...base, id, kind: "tool_call", callId: typeof block.id === "string" ? block.id : null, content: json(block) }));
      else if (block.type === "tool_result") events.push(event({ ...base, id, kind: "tool_result", role: "tool", callId: typeof block.tool_use_id === "string" ? block.tool_use_id : null, content: json(block) }));
      else events.push(event({ ...base, id, kind: "unknown", content: json(block) }));
    }
    if (message.stop_reason === "end_turn") events.push(event({ ...base, id: `${row.uuid}:terminal`, kind: "terminal", content: { status: "completed" } }));
  }
  if (rows.some(row => row.type === "system" && row.subtype === "compact_boundary")) events.unshift(event({ id: `compaction-${contentHash(rows.filter(row => row.subtype === "compact_boundary")).slice(0, 32)}`, kind: "compaction", content: { source: "claude_compact_boundary" } }));
  return normalizeConnectedSession({ origin: "claude_code", sessionId: [...sessionIds][0]!,
    // A chosen leaf is a cutoff, not a new family or the identity of every turn.
    branchId: null, parentSessionId: typeof chain[0]?.parentSessionId === "string" ? chain[0].parentSessionId : null,
    exporterVersion: typeof chain.at(-1)?.version === "string" ? chain.at(-1)!.version as string : null,
    files: [file], events, contextComplete: !missingParent, warnings: [...(missingParent ? ["The transcript omits an ancestor; complete context is unavailable."] : []),
      ...(chain.some(row => row.isSidechain) ? ["This is a subagent/sidechain transcript; parent context is not implicitly imported."] : []),
      "Claude Code transcript schema is internal; only the declared message shapes are normalized."] });
}
