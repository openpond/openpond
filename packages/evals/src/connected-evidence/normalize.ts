import { contentHash, contentHashArrayPrefixes } from "@openpond/harness";
import { CONNECTED_EVIDENCE_LIMITS, CONNECTED_EVIDENCE_VERSION, CONNECTED_NORMALIZER_VERSION, ConnectedSessionSchema, hasRecordedConnectedAnswer,
  type ConnectedBoundary, type ConnectedEvent, type ConnectedFile, type ConnectedSession, type ConnectedSourceKind } from "./contracts.js";

export function connectedTimestamp(value: unknown, units: "seconds" | "milliseconds" = "milliseconds"): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const time = new Date(typeof value === "number" && units === "seconds" ? value * 1_000 : value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
export function connectedFileIdentity(file: ConnectedFile) {
  return { path: file.path, contentHash: contentHash(file.text), sizeBytes: new TextEncoder().encode(file.text).length };
}
export function normalizeConnectedSession(input: {
  origin: ConnectedSourceKind; sessionId: string; branchId?: string | null; parentSessionId?: string | null;
  exporterVersion?: string | null; files: ConnectedFile[]; events: ConnectedEvent[]; warnings?: string[]; contextComplete?: boolean; includeConversation?: boolean;
  unmappedEvents?: ConnectedEvent[]; acquisition?: { machineId: string; sourceInstanceId: string };
}): ConnectedSession {
  if (input.events.length + (input.unmappedEvents?.length ?? 0) > CONNECTED_EVIDENCE_LIMITS.events) throw new Error("connected_event_limit");
  const events = input.events.map((event, sequence) => ({ ...event, sequence }));
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error("connected_duplicate_event");
  const starts = events.flatMap((event, index) => event.kind === "message" && event.role === "user" ? [index] : []);
  if (!starts.length) throw new Error("The session has no retained user request.");
  if (starts.length + (input.includeConversation === false ? 0 : 1) > CONNECTED_EVIDENCE_LIMITS.boundaries) throw new Error("connected_boundary_limit");
  const familyKey = `family-${contentHash([input.origin, ...(input.acquisition ? [input.acquisition.sourceInstanceId] : []), input.parentSessionId ?? input.sessionId]).slice(0, 32)}`;
  const inputHashes = contentHashArrayPrefixes(events, starts.map(start => start + 1));
  const firstCompaction = events.findIndex(event => event.kind === "compaction");
  const boundaries = starts.map((start, position): ConnectedBoundary => {
    const end = starts[position + 1] ?? events.length;
    const observed = events.slice(start + 1, end);
    const answer = observed.filter(hasRecordedConnectedAnswer).at(-1);
    const tools = observed.filter(event => event.kind === "tool_call" || event.kind === "tool_result");
    const calls = new Set(tools.filter(event => event.kind === "tool_call").map(event => event.callId));
    const results = new Set(tools.filter(event => event.kind === "tool_result").map(event => event.callId));
    const incomplete = tools.some(event => !event.callId) || [...calls].some(id => !results.has(id)) || [...results].some(id => !calls.has(id));
    const terminal = [...observed].reverse().find(event => event.kind === "terminal");
    const status = terminal && typeof terminal.content === "object" && terminal.content !== null && !Array.isArray(terminal.content)
      ? terminal.content.status : null;
    const compacted = firstCompaction >= 0 && firstCompaction <= start;
    const unknown = observed.some(event => event.kind === "unknown");
    return {
      id: `case-${contentHash([input.origin, ...(input.acquisition ? [input.acquisition.sourceInstanceId] : []), input.sessionId, input.branchId ?? null, events[start]!.id]).slice(0, 40)}`,
      familyKey, projection: "turn", requestEventId: events[start]!.id, start, end,
      inputHash: inputHashes[position]!, outputHash: answer ? contentHash(answer.content) : null,
      revisionHash: contentHash(observed), terminal: status === "completed" || status === "failed" || status === "cancelled" ? status : "unknown",
      coverage: { answer: Boolean(answer), context: input.contextComplete === false ? "unknown" : compacted ? "compacted" : "retained",
        process: !tools.length ? unknown ? "partial" : "absent" : incomplete || unknown ? "partial" : "retained",
        artifacts: observed.some(event => event.kind === "artifact") ? "references_only" : "absent", replay: "unavailable",
        gaps: [...(!answer ? ["No recorded assistant answer."] : []), ...(input.contextComplete === false ? ["The source omits preceding context."] : []), ...(compacted ? ["Earlier context was compacted by the source."] : []),
          ...(incomplete ? ["Tool call/result correlation is incomplete."] : []), ...(unknown ? ["Some source events have no supported process mapping."] : []),
          ...(!terminal ? ["No terminal receipt was recorded."] : []), "No resettable execution environment was admitted."] },
    };
  });
  if (input.includeConversation !== false) {
    const first = boundaries[0]!, last = boundaries.at(-1)!;
    const observed = events.slice(first.start + 1), answers = observed.filter(hasRecordedConnectedAnswer);
    boundaries.push({ ...first, id: `conversation-${contentHash([input.origin, ...(input.acquisition ? [input.acquisition.sourceInstanceId] : []), input.sessionId, input.branchId ?? null]).slice(0, 40)}`,
      projection: "conversation", end: events.length, outputHash: answers.length ? contentHash(answers.map(event => event.content)) : null,
      revisionHash: contentHash(observed), terminal: last.terminal, coverage: { ...first.coverage,
        answer: answers.length > 0, process: boundaries.some(item => item.coverage.process === "partial") ? "partial" : boundaries.some(item => item.coverage.process === "retained") ? "retained" : "absent",
        context: boundaries.some(item => item.coverage.context === "unknown") ? "unknown" : boundaries.some(item => item.coverage.context === "compacted") ? "compacted" : "retained",
        artifacts: boundaries.some(item => item.coverage.artifacts === "references_only") ? "references_only" : "absent",
        gaps: [...new Set(boundaries.flatMap(item => item.coverage.gaps))].slice(0, 100) } });
  }
  const body = { schemaVersion: CONNECTED_EVIDENCE_VERSION, normalizerVersion: CONNECTED_NORMALIZER_VERSION,
    origin: input.origin, sessionId: input.sessionId, branchId: input.branchId ?? null, parentSessionId: input.parentSessionId ?? null,
    exporterVersion: input.exporterVersion ?? null, sourceFiles: input.files.map(connectedFileIdentity).sort((a, b) => a.path.localeCompare(b.path)),
    ...(input.acquisition ? { acquisition: input.acquisition } : {}),
    events, unmappedEvents: (input.unmappedEvents ?? []).map((event, sequence) => ({ ...event, sequence })), boundaries, warnings: input.warnings ?? [] };
  const session = ConnectedSessionSchema.parse({ ...body, contentHash: contentHash(body) });
  if (new TextEncoder().encode(JSON.stringify(session)).length > CONNECTED_EVIDENCE_LIMITS.decodedBytes) throw new Error("connected_normalized_size_limit");
  return session;
}

export function connectedJsonLines(file: ConnectedFile): Record<string, unknown>[] {
  const lines = file.text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines.length > CONNECTED_EVIDENCE_LIMITS.events + 1) throw new Error("connected_event_limit");
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    if (new TextEncoder().encode(line).length > CONNECTED_EVIDENCE_LIMITS.lineBytes) throw new Error(`Source line ${index + 1} exceeds the limit.`);
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${index + 1}.`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Unsupported record on line ${index + 1}.`);
    return [value as Record<string, unknown>];
  });
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function event(input: Partial<ConnectedEvent> & Pick<ConnectedEvent, "id" | "kind" | "content">): ConnectedEvent {
  return { sequence: 0, occurredAt: null, role: null, callId: null, parentId: null, usage: null, ...input };
}
export function json(value: unknown): ConnectedEvent["content"] { return JSON.parse(JSON.stringify(value ?? null)); }
