import { contentHash } from "@openpond/harness";
import { connectedTimestamp, object } from "../normalize.js";

export type ClaudeBranch = { leafId: string; chainHash: string; title: string; updatedAt: string | null; messages: number };

/** One native graph owns selection, import and Desktop inspection semantics. */
export function claudeGraph(rows: Record<string, unknown>[]) {
  const messages = rows.filter(row => (row.type === "user" || row.type === "assistant") && typeof row.uuid === "string");
  const sessions = new Set(messages.flatMap(row => typeof row.sessionId === "string" ? [row.sessionId] : []));
  if (sessions.size !== 1 || !messages.length) throw new Error("A supported Claude Code transcript must identify one session with UUID messages.");
  const sessionId = [...sessions][0]!;
  const nodes = rows.filter(row => typeof row.uuid === "string" && row.sessionId === sessionId);
  const byId = new Map(nodes.map(row => [row.uuid as string, row]));
  if (byId.size !== nodes.length) throw new Error("Claude Code transcript contains duplicate message UUIDs.");
  const parents = new Set(nodes.flatMap(row => typeof row.parentUuid === "string" ? [row.parentUuid] : []));
  const leaves = nodes.filter(row => !parents.has(row.uuid as string));
  if (!leaves.length) throw new Error("Claude Code transcript has no selectable branch leaf.");
  function select(leafId: string) {
    let current = byId.get(leafId);
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
    return { chain, missingParent, chainHash: contentHash(chain) };
  }
  function branches(): ClaudeBranch[] {
    if (leaves.length > 256) throw new Error("This transcript exceeds the 256-branch inspection limit.");
    return leaves.map(leaf => {
      const selected = select(leaf.uuid as string);
      const messages = selected.chain.filter(row => row.type === "user" || row.type === "assistant");
      const last = messages.at(-1);
      const content = object(last?.message).content;
      const title = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap(block => typeof object(block).text === "string" ? [object(block).text] : []).join(" ") : "";
      return { leafId: leaf.uuid as string, chainHash: selected.chainHash, title: title.slice(0, 180), updatedAt: connectedTimestamp(last?.timestamp), messages: messages.length };
    });
  }
  return { sessionId, leaves, select, branches };
}
