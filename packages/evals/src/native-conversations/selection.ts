import { contentHash } from "@openpond/harness";
import { z } from "zod";
import type { NativeSession, NativeSource } from "./contracts.js";
import { listSessions } from "./history.js";
import type { CollectorConnection } from "./collector-contracts.js";

export const NativeUploadSelectionSchema = z.object({
  sourceInstanceId: z.string().min(1).max(500),
  sessionKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(10_000),
}).strict().refine(value => new Set(value.sessionKeys).size === value.sessionKeys.length, "Conversation selection contains duplicates.");

/** Includes the source path so duplicate native IDs cannot select a sibling file. */
export function nativeSessionSelectionKey(session: Pick<NativeSession, "path" | "nativeSessionId">) {
  return contentHash(JSON.stringify([session.path, session.nativeSessionId]));
}

export async function nativeUploadInventory(source: NativeSource) {
  if (!source.available || !source.capabilities.history) throw new Error("The selected conversation source is unavailable.");
  const items: NativeSession[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await listSessions(source, { cursor, limit: 100 });
    items.push(...page.items);
    if (items.length > 10_000) throw new Error("Choose a source with no more than 10,000 conversations.");
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Conversation listing did not advance. Refresh the source.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export async function validateNativeUploadSelection(source: NativeSource, raw: unknown) {
  const selection = NativeUploadSelectionSchema.parse(raw);
  if (selection.sourceInstanceId !== source.instanceId) throw new Error("Conversation selection belongs to another source installation.");
  const available = new Set((await nativeUploadInventory(source)).map(nativeSessionSelectionKey));
  if (selection.sessionKeys.some(key => !available.has(key))) throw new Error("A selected conversation is no longer available. Refresh and select it again.");
  return selection;
}

export function nativeUploadConversationPage(connection: Pick<CollectorConnection, "selectedSessionKeys">, inventory: NativeSession[], input: { query?: string; range?: string; offset?: number }) {
  const query = (input.query ?? "").trim().toLocaleLowerCase(), range = input.range ?? "all", offset = input.offset ?? 0;
  if (query.length > 500 || !["day", "week", "all"].includes(range) || !Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new Error("Invalid conversation search or page.");
  const since = range === "all" ? 0 : Date.now() - (range === "day" ? 1 : 7) * 86400000;
  const items = inventory.filter(item => Date.parse(item.updatedAt) >= since &&
    (!query || [item.title, item.cwd, item.nativeSessionId].some(text => text?.toLocaleLowerCase().includes(query))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const approved = connection.selectedSessionKeys ? new Set(connection.selectedSessionKeys) : null;
  return {
    total: items.length, nextOffset: offset + 50 < items.length ? offset + 50 : null,
    items: items.slice(offset, offset + 50).map(item => ({
      key: nativeSessionSelectionKey(item), title: item.title, cwd: item.cwd,
      nativeSessionId: item.nativeSessionId, updatedAt: item.updatedAt, issue: item.issue ?? null,
      approved: approved === null || approved.has(nativeSessionSelectionKey(item)),
    })),
  };
}
