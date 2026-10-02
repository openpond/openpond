import { contentHash } from "@openpond/harness";
import { CONNECTED_EVIDENCE_LIMITS, type ConnectedFile, type ConnectedSession, type ConnectedSourceKind } from "./contracts.js";
import { connectedJsonLines, normalizeConnectedSession } from "./normalize.js";
import { parsePiSession } from "./sources/pi.js";
import { parseOpenCodeSession } from "./sources/opencode.js";
import { parseCodexSession } from "./sources/codex.js";
import { parseClaudeSession } from "./sources/claude-code.js";
import { parseHermesEvidence, parseOpenClawEvidence } from "./sources/history.js";

export type ExternalAgentSource = Exclude<ConnectedSourceKind, "native_chat" | "native_work">;
export type AgentImportPreview = {
  schemaVersion: "openpond.agentImportPreview.v1"; source: ExternalAgentSource; sourceHash: string;
  sessions: ConnectedSession[]; issues: { file: string; message: string }[];
};

/** Never admits malformed files partly or executes referenced paths/commands. */
export function previewAgentImport(input: { source: ExternalAgentSource; files: ConnectedFile[]; branchLeafId?: string; acquisition?: { machineId: string; sourceInstanceId: string } }): AgentImportPreview {
  if (!input.files.length || input.files.length > CONNECTED_EVIDENCE_LIMITS.files) throw new Error("Choose between 1 and 100 source files.");
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of input.files) {
    if (file.path.length > 500 || file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(file.path))
      throw new Error("Unsafe or duplicate source file path.");
    paths.add(file.path);
    bytes += new TextEncoder().encode(file.text).length;
  }
  if (bytes > CONNECTED_EVIDENCE_LIMITS.decodedBytes) throw new Error("Decoded source files exceed 64 MiB.");
  const sessions: ConnectedSession[] = [], issues: AgentImportPreview["issues"] = [];
  const attempt = (file: string, parse: () => ConnectedSession[]) => {
    try { sessions.push(...parse().map(session => input.acquisition ? normalizeConnectedSession({ origin: session.origin, sessionId: session.sessionId, branchId: session.branchId, parentSessionId: session.parentSessionId, exporterVersion: session.exporterVersion, files: input.files.filter(item => session.sourceFiles.some(file => file.path === item.path)), events: session.events, unmappedEvents: session.unmappedEvents, warnings: session.warnings, acquisition: input.acquisition }) : session)); } catch (error) { issues.push({ file, message: error instanceof Error ? error.message : "Unsupported session." }); }
  };
  if (input.source === "openclaw") attempt("manifest.json", () => {
    const root = input.files[0]!.path.split("/")[0]!;
    const files = !input.files.some(file => file.path === "manifest.json") && input.files.every(file => file.path.startsWith(`${root}/`))
      ? input.files.map(file => ({ ...file, path: file.path.slice(root.length + 1) })) : input.files;
    return [parseOpenClawEvidence(files)];
  });
  else for (const file of input.files) attempt(file.path, () => {
    if (input.source === "opencode") return [parseOpenCodeSession(file, JSON.parse(file.text))];
    let rows: Record<string, unknown>[];
    if (input.source === "hermes" && file.path.endsWith(".json")) {
      const value: unknown = JSON.parse(file.text.replace(/^\uFEFF/u, ""));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hermes session backup must be one JSON object.");
      rows = [value as Record<string, unknown>];
    } else rows = connectedJsonLines(file);
    if (input.source === "pi" || input.source === "oh_my_pi") return [parsePiSession(file, rows, input.source, input.branchLeafId)];
    if (input.source === "codex") return [parseCodexSession(file, rows)];
    if (input.source === "claude_code") return [parseClaudeSession(file, rows, input.branchLeafId)];
    if (input.source === "hermes") return rows.map(row => parseHermesEvidence(file, row));
    throw new Error("Unsupported source adapter.");
  });
  if (sessions.length > CONNECTED_EVIDENCE_LIMITS.sessions || sessions.reduce((total, session) => total + session.events.length + session.unmappedEvents.length, 0) > CONNECTED_EVIDENCE_LIMITS.events
    || sessions.reduce((total, session) => total + session.boundaries.length, 0) > CONNECTED_EVIDENCE_LIMITS.boundaries)
    throw new Error("Import exceeds the session/event/boundary limit.");
  const identities = new Map<string, string>();
  for (const session of sessions) {
    const key = JSON.stringify([session.origin, session.sessionId, session.branchId]);
    const prior = identities.get(key);
    if (prior && prior !== session.contentHash) throw new Error("The same session has different contents in this selection. Choose one export.");
    identities.set(key, session.contentHash);
  }
  return { schemaVersion: "openpond.agentImportPreview.v1", source: input.source,
    sourceHash: contentHash({ source: input.source, files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)), branchLeafId: input.branchLeafId ?? null }),
    sessions: sessions.filter((session, index) => sessions.findIndex(other => other.contentHash === session.contentHash) === index), issues };
}
