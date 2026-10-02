import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { NativeSession, NativeSource } from "./contracts.js";
import { NATIVE_READ_LIMIT } from "./contracts.js";

function open(source: NativeSource) {
  const file = source.root.endsWith(".db") ? source.root : join(source.root, source.source === "opencode" ? "opencode.db" : "state.db");
  const database = new DatabaseSync(file, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false });
  database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
  return database;
}
export function listDatabaseSessions(source: NativeSource, input: { since?: string; cursor?: string; limit: number }) {
  const database = open(source);
  try {
    const since = input.since ? Date.parse(input.since) : 0;
    const rows = source.source === "opencode"
      ? database.prepare("SELECT id,title,directory AS cwd,time_updated AS updated FROM session WHERE id > ? AND time_updated >= ? ORDER BY id LIMIT ?").all(input.cursor ?? "", since, input.limit + 1)
      : database.prepare("SELECT id,title,cwd,MAX(COALESCE(last_activity_at,0),started_at) * 1000 AS updated FROM sessions WHERE id > ? AND MAX(COALESCE(last_activity_at,0),started_at) * 1000 >= ? ORDER BY id LIMIT ?").all(input.cursor ?? "", since, input.limit + 1);
    const items: NativeSession[] = rows.slice(0, input.limit).map(row => ({ nativeSessionId: String(row.id), sourceInstanceId: source.instanceId,
      path: String(row.id), title: typeof row.title === "string" ? row.title : String(row.id), cwd: typeof row.cwd === "string" ? row.cwd : null, updatedAt: new Date(Number(row.updated)).toISOString() }));
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.nativeSessionId : null };
  } finally { database.close(); }
}
export function readDatabaseSession(source: NativeSource, sessionId: string) {
  const database = open(source);
  try {
    let result: unknown;
    if (source.source === "opencode") {
      const info = database.prepare("SELECT id,title,directory,parent_id,version,time_created,time_updated FROM session WHERE id = ?").get(sessionId);
      if (!info) throw new Error("Native session is unavailable.");
      const rows = database.prepare("SELECT id,data FROM message WHERE session_id = ? ORDER BY time_created,id LIMIT 100001").all(sessionId);
      if (rows.length > 100000) throw new Error("Native session exceeds the event limit.");
      let bytes = 0;
      const messages = rows.map(row => {
        bytes += Buffer.byteLength(String(row.data));
        if (bytes > NATIVE_READ_LIMIT) throw new Error("Native session exceeds the retained byte limit.");
        const parts = database.prepare("SELECT id,data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created,id LIMIT 100001").all(sessionId, String(row.id));
        if (parts.length > 100000) throw new Error("Native parts exceed the event limit.");
        return { info: { ...JSON.parse(String(row.data)), id: row.id, sessionID: sessionId }, parts: parts.map(part => {
          bytes += Buffer.byteLength(String(part.data));
          if (bytes > NATIVE_READ_LIMIT) throw new Error("Native session exceeds the retained byte limit.");
          return { ...JSON.parse(String(part.data)), id: part.id, sessionID: sessionId, messageID: row.id };
        }) };
      });
      result = { info: { ...info, parentID: info.parent_id, time: { created: info.time_created, updated: info.time_updated } }, messages };
    } else {
      const info = database.prepare("SELECT id,title,parent_session_id,system_prompt FROM sessions WHERE id = ?").get(sessionId);
      if (!info) throw new Error("Native session is unavailable.");
      const rows = database.prepare("SELECT id,role,content,tool_call_id,tool_calls,timestamp,finish_reason,compacted FROM messages WHERE session_id = ? AND active = 1 ORDER BY id LIMIT 100001").all(sessionId);
      if (rows.length > 100000) throw new Error("Native session exceeds the event limit.");
      let bytes = 0;
      result = { ...info, messages: rows.map(row => {
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > NATIVE_READ_LIMIT) throw new Error("Native session exceeds the retained byte limit.");
        return { ...row, tool_calls: typeof row.tool_calls === "string" ? JSON.parse(row.tool_calls) : null };
      }), message_count: rows.length };
    }
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > NATIVE_READ_LIMIT) throw new Error("Native session exceeds the retained byte limit.");
    return { path: `${sessionId}.json`, text };
  } finally { database.close(); }
}
