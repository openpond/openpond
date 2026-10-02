import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { nativeTerminalCommand } from "./terminal-command.js";
import { join } from "node:path";
import { z } from "zod";
import { SessionSchema, TurnSchema, type RuntimeEvent, type Session } from "@openpond/contracts";
import { discoverSources, listSessions, readSession, inspectSessionBranches, collectorDirectory, collectorMachineId, collectorStatus, controlCollector, startCollectorService, installCollectorService, type NativeSource, type NativeSession, type NativeBranchChoice } from "@openpond/evals/native-conversations";
import type { SqliteStore } from "../../store/store.js";
import { readProvidersFile } from "../../openpond/provider-settings.js";
import { nativeAgentLaunch, type NativeAgentId } from "./config.js";
import { event } from "../../utils.js";
import { nativeEventText as text, ownedNativeBoundaryIds } from "./history-ownership.js";
const providerFor = { claude_code: "claude-code", opencode: "opencode", grok_build: "grok-build" } as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Read-only native acquisition, with local projections for the existing chat UI. No cloud admission. */
export function createNativeHistory(deps: { store: SqliteStore; storeDir: string; appendRuntimeEvent(value: RuntimeEvent): Promise<void> }) {
  const selected = new Map<string, { source: NativeSource; session: NativeSession; provider: NativeAgentId }>();
  const opening = new Map<string, Promise<Session>>();
  async function list(cursors: Record<string, string> = {}) {
    const directory = collectorDirectory(); const machineId = await collectorMachineId(directory);
    const file = await readProvidersFile(join(deps.storeDir, "providers.json"));
    const locations: Partial<Record<NativeSource["source"], string>> = {};
    for (const [source, provider] of Object.entries(providerFor)) {
      const home = file.providers[provider]?.sourceHome;
      if (home) locations[source as NativeSource["source"]] = source === "opencode" ? join(home, "opencode") : home;
    }
    const sources = (await discoverSources({ machineId, locations })).filter((source) => source.source in providerFor);
    const items: Array<{ id: string; source: string; title: string; cwd: string | null; updatedAt: string; nativeSessionId: string; sourceInstanceId: string }> = [];
    const warnings: string[] = [];
    const nextCursors: Record<string, string> = {};
    for (const source of sources) {
      if (Object.keys(cursors).length && !cursors[source.instanceId]) continue;
      if (!source.capabilities.history) { if (source.available && source.reason) warnings.push(`${source.source}: ${source.reason}`); continue; }
      const provider = providerFor[source.source as keyof typeof providerFor];
      try {
        const page = await listSessions(source, { limit: 50, cursor: cursors[source.instanceId] });
        for (const session of page.items) {
          const id = hash([source.instanceId, session.nativeSessionId]);
          selected.set(id, { source, session, provider });
          items.push({ id, source: provider, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt, nativeSessionId: session.nativeSessionId, sourceInstanceId: source.instanceId });
        }
        if (page.nextCursor) nextCursors[source.instanceId] = page.nextCursor;
      } catch (error) { warnings.push(`${provider}: ${error instanceof Error ? error.message : "History unavailable"}`); }
    }
    return { sources, nextCursors, items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings, collector: await collectorStatus(directory) };
  }
  async function selection(id: string) {
    if (!selected.has(id)) await list();
    const item = selected.get(id); if (!item) throw new Error("Native history selection expired; refresh the source list.");
    return item;
  }
  async function open(id: string, branch?: NativeBranchChoice): Promise<Session> {
    const projectionId = branch ? hash([id, branch.leafId, branch.revision]) : id;
    const openingKey = branch ? hash([projectionId, branch.revision]) : projectionId;
    const existing = opening.get(openingKey); if (existing) return existing;
    const operation = (async () => {
      const item = await selection(id);
      if (branch && item.provider !== "claude-code") throw new Error("Explicit branch selection is only supported for Claude Code.");
      const retained = await readSession(item.source, item.session, branch ? { branchLeafId: branch.leafId, expectedBranchRevision: branch.revision } : {});
      const native = retained.preview.sessions.find((session) => session.sessionId === item.session.nativeSessionId);
      if (!native) throw new Error("Source history does not match the selected native session.");
      const config = (await readProvidersFile(join(deps.storeDir, "providers.json"))).providers[item.provider];
      const instance = nativeAgentLaunch(item.provider, config).instanceId;
      const shells = await deps.store.sessionShells();
      const owned = !branch ? shells.find((session) => session.nativeAgent?.provider === item.provider && session.nativeAgent.instanceId === instance && session.nativeAgent.sessionId === native.sessionId) : undefined;
      const sessionId = owned?.id ?? `native-${projectionId}`;
      let session = owned ?? await deps.store.getSession(sessionId);
      const timestamp = item.session.updatedAt;
      if (!session) {
        session = SessionSchema.parse({ id: sessionId, experience: "work", provider: item.provider, title: `${item.session.title}${branch ? ` · Branch ${branch.leafId.slice(0, 8)}` : ""}`, appId: null, appName: null, cwd: item.session.cwd, codexThreadId: null, createdAt: timestamp, updatedAt: timestamp, status: "idle", pinned: false, archived: false, order: 0,
          nativeAgent: item.session.cwd && !branch ? { provider: item.provider, instanceId: instance, sessionId: native.sessionId, cwd: item.session.cwd } : null,
          metadata: { nativeHistoryProjection: true, sourceInstanceId: item.source.instanceId, sourceMachineId: item.source.machineId, nativeSource: item.source.source, nativeResumeAvailable: Boolean(item.session.cwd) && !branch, nativeSourceHash: native.contentHash, ...(branch ? { nativeBranch: branch, nativeReadOnlyReason: "Read-only Claude branch snapshot. Choose another branch from Local agents to inspect it." } : {}) } });
        await deps.store.insertSessionAtFront(session);
        await deps.appendRuntimeEvent(event({ sessionId, name: "session.started", source: "server", data: { session, retainedHistory: true } }));
      }
      if (session.metadata?.nativeHistoryProjection && !session.nativeAgent && item.session.cwd && !branch && !session.metadata.nativeBranch) {
        const updated = await deps.store.updateSession(sessionId, (current) => ({ ...current, cwd: item.session.cwd, nativeAgent: { provider: item.provider, instanceId: instance, sessionId: native.sessionId, cwd: item.session.cwd! }, metadata: { ...current.metadata, nativeResumeAvailable: true } }));
        if (updated) session = updated;
      }
      const events = await deps.store.runtimeEventsForSession(sessionId);
      const existingIds = new Set(events.map((event) => event.id));
      const retainedTurns = await deps.store.turnsForSession(sessionId, 10_000);
      // A process can stop after the durable terminal write and before its UI
      // notification. Reconcile that gap without changing the recorded outcome.
      for (const turn of retainedTurns) {
        if (turn.status === "in_progress" || events.some((value) => value.turnId === turn.id && ["turn.completed", "turn.failed", "turn.interrupted"].includes(value.name))) continue;
        await deps.appendRuntimeEvent({ id: `native-recovery-${hash([turn.id, turn.status])}`, sessionId, turnId: turn.id, timestamp: turn.completedAt ?? timestamp, name: turn.status === "completed" ? "turn.completed" : turn.status === "failed" ? "turn.failed" : "turn.interrupted", source: "server", data: { retainedHistory: true } });
      }
      const ownedTurns = retainedTurns.filter((turn) => typeof turn.metadata?.nativePromptHash === "string");
      const ownedBoundaries = ownedNativeBoundaryIds(native, ownedTurns);
      const ownedIndexes = new Set(native.boundaries.filter((boundary) => ownedBoundaries.has(boundary.id)).flatMap((boundary) => Array.from({ length: boundary.end - boundary.start }, (_, index) => boundary.start + index)));
      let turnId: string | undefined;
      for (const [index, sourceEvent] of native.events.entries()) {
        if (ownedIndexes.has(index)) continue;
        const eventId = `native-${hash([projectionId, sourceEvent.id, sourceEvent.kind === "message" && sourceEvent.role === "assistant" ? sourceEvent.content : null])}`;
        const common = { id: eventId, sessionId, timestamp: sourceEvent.occurredAt ?? timestamp, source: "provider" as const };
        let normalized: RuntimeEvent | null = null;
        if (sourceEvent.kind === "message" && sourceEvent.role === "user") { turnId = `native-turn-${hash([projectionId, sourceEvent.id])}`; normalized = { ...common, turnId, name: "turn.started", args: { prompt: text(sourceEvent.content) }, data: { retainedHistory: true, sourceEventId: sourceEvent.id } }; }
        else if (sourceEvent.kind === "message" && sourceEvent.role === "assistant") normalized = { ...common, turnId, name: "assistant.delta", output: text(sourceEvent.content), data: { retainedHistory: true, nativeMessageId: `native-message-${hash([projectionId, sourceEvent.id])}`, delta: text(sourceEvent.content) } };
        else if (sourceEvent.kind === "tool_call" || sourceEvent.kind === "tool_result") normalized = { ...common, turnId, name: sourceEvent.kind === "tool_call" ? "tool.started" : "tool.completed", action: "native_tool", status: sourceEvent.kind === "tool_call" ? "started" : "completed", data: { retainedHistory: true, callId: sourceEvent.callId, content: sourceEvent.content } };
        if (normalized && !existingIds.has(eventId)) await deps.appendRuntimeEvent(normalized);
      }
      for (const boundary of native.boundaries.filter((entry) => entry.projection === "turn")) {
        if (ownedBoundaries.has(boundary.id)) continue;
        const request = native.events[boundary.start];
        if (!request) continue;
        const retainedTurnId = `native-turn-${hash([projectionId, request.id])}`;
        const status = boundary.terminal === "completed" ? "completed" : boundary.terminal === "failed" ? "failed" : "interrupted";
        const turn = TurnSchema.parse({ id: retainedTurnId, sessionId, providerTurnId: native.sessionId, prompt: text(request.content), startedAt: request.occurredAt ?? timestamp, completedAt: native.events[boundary.end - 1]?.occurredAt ?? timestamp, status, error: boundary.terminal === "unknown" ? "The retained source does not report a completion status." : null, metadata: { retainedHistory: true, sourceTerminal: boundary.terminal, sourceBoundaryId: boundary.id } });
        if (await deps.store.getTurn(retainedTurnId)) await deps.store.updateTurn(retainedTurnId, () => turn);
        else await deps.store.insertTurn(turn);
        const terminalId = `native-terminal-${hash([projectionId, boundary.id, boundary.revisionHash, boundary.terminal])}`;
        if (!existingIds.has(terminalId)) await deps.appendRuntimeEvent({ id: terminalId, sessionId, turnId: retainedTurnId, name: status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted", timestamp: turn.completedAt!, source: "provider", data: { retainedHistory: true, sourceTerminal: boundary.terminal } });
      }
      return session;
    })();
    opening.set(openingKey, operation); try { return await operation; } finally { opening.delete(openingKey); }
  }
  return async (action: string, payload: unknown) => {
    if (action === "list") return list(z.object({ cursors: z.record(z.string().max(200), z.string().max(4096)).optional() }).parse(payload ?? {}).cursors);
    if (action === "branches") {
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(payload);
      const item = await selection(id);
      return inspectSessionBranches(item.source, item.session);
    }
    if (action === "open") {
      const { id, branch } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), branch: z.object({ leafId: z.string().min(1).max(200), revision: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).parse(payload);
      return open(id, branch);
    }
    if (action === "collector") {
      const { command } = z.object({ command: z.enum(["status", "start", "stop", "sync", "install", "connect"]) }).parse(payload);
      const directory = collectorDirectory();
      if (command === "status") return collectorStatus(directory);
      if (command === "install" || command === "connect") {
        const cli = process.env.OPENPOND_COLLECTOR_CLI;
        const executable = process.env.OPENPOND_COLLECTOR_EXECUTABLE;
        if (!cli || !executable) throw new Error("The bundled Importer is unavailable. Install the OpenPond CLI to connect a source.");
        await access(cli); await access(executable);
        const environment = { ELECTRON_RUN_AS_NODE: "1", ...(process.env.OPENPOND_HOME ? { OPENPOND_HOME: process.env.OPENPOND_HOME } : {}) };
        if (command === "connect") return { command: nativeTerminalCommand(executable, [cli, "import", "connect", "--collector-dir", directory], environment) };
        return installCollectorService({ directory, executable, args: [cli], environment });
      }
      if (command === "start") return startCollectorService(directory);
      return controlCollector(directory, command);
    }
    throw new Error("Unknown native history action.");
  };
}
