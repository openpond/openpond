import type { TrainingChatSearchResult } from "@openpond/contracts";

export type TrainingChatSearchResultRow = {
  session_id: string;
  title: string;
  updated_at: string;
  snippet: string | null;
};

export function trainingChatSearchResult(
  query: string,
  offset: number,
  limit: number,
  total: number,
  rows: TrainingChatSearchResultRow[],
  indexedChats: number,
  totalChats: number,
): TrainingChatSearchResult {
  return {
    schemaVersion: "openpond.trainingChatSearchResult.v1",
    query,
    offset,
    limit,
    total,
    hasMore: offset + rows.length < total,
    indexedChats,
    totalChats,
    indexing: indexedChats < totalChats,
    entries: rows.map((row) => ({
      sessionId: row.session_id,
      title: row.title,
      updatedAt: row.updated_at,
      snippet: row.snippet?.trim() || null,
    })),
  };
}

export function trainingChatFtsQuery(query: string): string | null {
  const tokens =
    query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? [];
  if (!tokens.length) return null;
  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

export function appendTrainingChatSearchText(
  target: Map<string, string[]>,
  sessionId: string,
  text: string,
): void {
  const values = target.get(sessionId) ?? [];
  values.push(text);
  target.set(sessionId, values);
}
