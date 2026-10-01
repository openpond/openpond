import { contentHash } from "@openpond/harness";
import type { ConnectedEvent, ConnectedFile } from "../contracts.js";
import { connectedJsonLines, connectedTimestamp, event, json, normalizeConnectedSession, object } from "../normalize.js";
import { sourceUsage } from "./usage.js";

function historyEvents(messages: unknown[], origin: string): ConnectedEvent[] {
  const events: ConnectedEvent[] = [];
  for (const [index, value] of messages.entries()) {
    const message = object(value);
    const id = typeof message.entryId === "string" ? message.entryId : typeof message.id === "string" ? message.id : typeof message.id === "number" && Number.isSafeInteger(message.id) ? String(message.id)
      : typeof message.message_id === "string" ? message.message_id : `${origin}-${contentHash([index, message]).slice(0, 32)}`;
    const base = { occurredAt: connectedTimestamp(message.timestamp, origin === "hermes" ? "seconds" : "milliseconds"),
      parentId: typeof message.parentId === "string" ? message.parentId : null };
    if (message.role === "tool") {
      events.push(event({ ...base, id, kind: "tool_result", role: "tool", callId: typeof message.tool_call_id === "string" ? message.tool_call_id : null, content: json(message.content) }));
      continue;
    }
    if (!["user", "assistant", "system"].includes(String(message.role))) {
      events.push(event({ ...base, id, kind: "unknown", content: json(message) })); continue;
    }
    events.push(event({ ...base, id, kind: "message", role: message.role as "user" | "assistant" | "system", content: json(message.content),
      usage: sourceUsage(message.usage, id) }));
    if (Array.isArray(message.tool_calls)) for (const [ordinal, value] of message.tool_calls.entries()) {
      const call = object(value);
      events.push(event({ ...base, id: `${id}:call:${ordinal}`, kind: "tool_call", callId: typeof call.id === "string" ? call.id : null, content: json(call) }));
    }
    if (message.finish_reason === "stop" || message.stop_reason === "end_turn")
      events.push(event({ ...base, id: `${id}:terminal`, kind: "terminal", content: { status: "completed" } }));
  }
  return events;
}
export function parseHermesEvidence(file: ConnectedFile, row: Record<string, unknown>) {
  const sessionId = typeof row.id === "string" ? row.id : typeof row.session_id === "string" ? row.session_id : null;
  if (!sessionId || !Array.isArray(row.messages)) throw new Error("Hermes requires a full-session export with id or session_id and messages.");
  if (row.message_count !== undefined && row.message_count !== row.messages.length) throw new Error("Hermes full-session message count differs from the retained messages.");
  const lineage = Array.isArray(row.lineage_session_ids) ? row.lineage_session_ids.find(id => typeof id === "string" && id) : null;
  const events = historyEvents(row.messages, "hermes");
  if (typeof row.system_prompt === "string" && row.system_prompt.trim()) events.unshift(event({ id: `hermes-system-${contentHash(row.system_prompt).slice(0, 32)}`, kind: "message", role: "system", content: row.system_prompt }));
  return normalizeConnectedSession({ origin: "hermes", sessionId, parentSessionId: typeof lineage === "string" ? lineage : typeof row.parent_session_id === "string" ? row.parent_session_id : null,
    exporterVersion: typeof row.version === "string" ? row.version : null, files: [file], events,
    warnings: ["Reported usage is not an OpenPond billing receipt.", "Exporter redaction and missing tools/artifacts remain evidence gaps.", ...(row.session_id && !row.id ? ["This is a Hermes session backup. Exporter version and terminal receipts may be unavailable."] : [])] });
}
export function parseOpenClawEvidence(files: ConnectedFile[]) {
  const read = (path: string) => { const file = files.find(file => file.path === path); if (!file) throw new Error(`OpenClaw bundle is missing ${path}.`); return file; };
  const manifest = object(JSON.parse(read("manifest.json").text));
  const branch = object(JSON.parse(read("session-branch.json").text));
  const eventsFile = read("events.jsonl"), rows = connectedJsonLines(eventsFile);
  if (manifest.traceSchema !== "openclaw-trajectory" || manifest.schemaVersion !== 1 || typeof manifest.sessionId !== "string" || typeof manifest.traceId !== "string")
    throw new Error("Unsupported OpenClaw trajectory manifest.");
  if (manifest.leafId !== branch.leafId || manifest.eventCount !== rows.length || rows.some(row => row.traceSchema !== manifest.traceSchema || row.schemaVersion !== 1 || row.sessionId !== manifest.sessionId || row.traceId !== manifest.traceId))
    throw new Error("OpenClaw bundle identity/count does not match its manifest.");
  if (!Array.isArray(branch.entries)) throw new Error("OpenClaw active branch entries are missing.");
  if (branch.header && object(branch.header).id !== manifest.sessionId) throw new Error("OpenClaw branch header differs from the manifest session.");
  const ids = new Set<string>(), messages: unknown[] = [];
  for (const [index, value] of branch.entries.entries()) {
    const entry = object(value);
    if (typeof entry.id !== "string" || ids.has(entry.id) || (index > 0 && entry.parentId !== object(branch.entries[index - 1]).id))
      throw new Error("OpenClaw active branch is duplicate, incomplete or unordered.");
    ids.add(entry.id);
    if (entry.type === "message") messages.push({ ...object(entry.message), entryId: entry.id,
      parentId: entry.parentId ?? null, timestamp: entry.timestamp ?? object(entry.message).timestamp });
  }
  if (branch.entries.length && object(branch.entries.at(-1)).id !== branch.leafId) throw new Error("OpenClaw branch does not reach its leaf.");
  // Branch messages carry context/output. Retain original events separately as
  // unknown process evidence until their exact lifecycle mapping is qualified.
  const events = historyEvents(messages, "openclaw"), unmappedEvents: ConnectedEvent[] = [];
  const seenSequences = new Set<unknown>();
  for (const [index, row] of rows.entries()) {
    if (!Number.isSafeInteger(row.seq) || (row.seq as number) < 0 || seenSequences.has(row.seq) || index > 0 && Number(rows[index - 1]!.seq) >= Number(row.seq)) throw new Error("OpenClaw events have invalid/duplicate/unordered sequences.");
    seenSequences.add(row.seq);
    unmappedEvents.push(event({ id: `trajectory:${manifest.traceId}:${row.seq}`, kind: "unknown", occurredAt: connectedTimestamp(row.ts), content: json(row) }));
  }
  return normalizeConnectedSession({ origin: "openclaw", sessionId: manifest.sessionId, files, events, unmappedEvents,
    exporterVersion: typeof manifest.openclawVersion === "string" ? manifest.openclawVersion : null,
    warnings: ["Raw trajectory events are retained; unqualified event types are not advertised as complete process grading.",
      ...(Array.isArray(manifest.warnings) ? manifest.warnings.map(value => typeof object(value).message === "string" ? String(object(value).message).slice(0, 500) : "The source exporter reports incomplete evidence.") : [])].slice(0, 100) });
}
