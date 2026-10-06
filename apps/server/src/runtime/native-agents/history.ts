import { createHash } from "node:crypto";
import { handleNativeImporter } from "./importer.js";
import { join } from "node:path";
import { z } from "zod";
import { SessionSchema, TurnSchema, type RuntimeEvent, type Session } from "@openpond/contracts";
import { discoverSources, listSessions, readSession, inspectSessionBranches, collectorDirectory, collectorMachineId, collectorStatus, type NativeSource, type NativeSession, type NativeBranchChoice } from "@openpond/evals/native-conversations";
import type { SqliteStore } from "../../store/store.js";
import { readProvidersFile } from "../../openpond/provider-settings.js";
import { nativeAgentLaunch, type NativeAgentId } from "./config.js";
import { event } from "../../utils.js";
import { matchingNativeHistorySession, retainNativeSidebarShell } from "./history-sidebar.js";
import { nativeEventText as text, ownedNativeBoundaryIds } from "./history-ownership.js";
import { nativeCapabilityProbeKey, nativeCapabilityProbeKeys } from "./capability-probes.js";
const providerFor = { claude_code: "claude-code", opencode: "opencode", grok_build: "grok-build" } as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Read-only native acquisition, with local projections for the existing chat UI. No cloud admission. */
export function createNativeHistory(deps: { store: SqliteStore; storeDir: string; appendRuntimeEvent(value: RuntimeEvent): Promise<void>; canResume?(provider: NativeAgentId, cwd: string): Promise<boolean | { available: boolean; reason: string | null }> }) {
  const selected = new Map<string, { source: NativeSource; session: NativeSession; provider: NativeAgentId }>();
  const opening = new Map<string, Promise<Session>>();
  async function list(cursors: Record<string, string> = {}, retain = false) {
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
    const shells = retain ? await deps.store.sessionShells() : [];
    for (const source of sources) {
      if (Object.keys(cursors).length && !cursors[source.instanceId]) continue;
      if (!source.capabilities.history) { if (source.available && source.reason) warnings.push(`${source.source}: ${source.reason}`); continue; }
      const provider = providerFor[source.source as keyof typeof providerFor];
      try {
        const launch = nativeAgentLaunch(provider, file.providers[provider]);
        const probes = await nativeCapabilityProbeKeys(launch.sourceHome);
        const page = await listSessions(source, { limit: 50, cursor: cursors[source.instanceId] });
        for (const session of page.items) {
          const id = hash([source.instanceId, session.nativeSessionId]);
          if (probes.has(nativeCapabilityProbeKey(provider, session.nativeSessionId))) {
            selected.delete(id);
            // A concurrent discovery refresh can observe session/new before its
            // registry append finishes. Reconcile only that known projection.
            const retained = shells.find((shell) => shell.provider === provider && shell.metadata?.sourceInstanceId === source.instanceId &&
              (shell.metadata?.nativeHistoryId === id || shell.id === `native-${id}`));
            if (retained && !retained.archived) {
              const updated = await deps.store.updateSession(retained.id, (current) => ({ ...current, archived: true }));
              if (updated) await deps.appendRuntimeEvent(event({ sessionId: updated.id, name: "session.updated", source: "server", data: { session: updated } }));
            }
            continue;
          }
          selected.set(id, { source, session, provider });
          items.push({ id, source: provider, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt, nativeSessionId: session.nativeSessionId, sourceInstanceId: source.instanceId });
          if (retain) {
            const result = await retainNativeSidebarShell(deps.store, shells, { id, source, session, provider, instanceId: nativeAgentLaunch(provider, file.providers[provider]).instanceId });
            if (result.changed) await deps.appendRuntimeEvent(event({ sessionId: result.session.id, name: "session.updated", source: "server", data: { session: result.session, retainedHistory: true } }));
          }
        }
        if (page.nextCursor) nextCursors[source.instanceId] = page.nextCursor;
      } catch (error) { warnings.push(`${provider}: ${error instanceof Error ? error.message : "History unavailable"}`); }
    }
    return { sources, nextCursors, items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings, collector: await collectorStatus(directory) };
  }
  async function selection(id: string) {
    if (!selected.has(id)) {
      const retained = await deps.store.getSession(`native-${id}`) ?? (await deps.store.sessionShells()).find((session) => session.metadata?.nativeHistoryId === id);
      let page = await list();
      const seen = new Set<string>();
      for (let index = 0; retained && !selected.has(id) && Object.keys(page.nextCursors).length && index < 100; index++) {
        const key = JSON.stringify(page.nextCursors);
        if (seen.has(key)) break;
        seen.add(key);
        page = await list(page.nextCursors);
      }
    }
    const item = selected.get(id); if (!item) throw new Error("Native history selection expired; refresh the source list.");
    return item;
  }
  async function open(id: string, branch?: NativeBranchChoice): Promise<Session> {
    const projectionId = branch ? hash([id, branch.leafId, branch.revision]) : id;
    const openingKey = branch ? hash([projectionId, branch.revision]) : projectionId;
    const existing = opening.get(openingKey); if (existing) return existing;
    const operation = (async () => {
      const item = await selection(id);
      const config = (await readProvidersFile(join(deps.storeDir, "providers.json"))).providers[item.provider];
      const launch = nativeAgentLaunch(item.provider, config);
      if ((await nativeCapabilityProbeKeys(launch.sourceHome)).has(nativeCapabilityProbeKey(item.provider, item.session.nativeSessionId)))
        throw new Error("Capability discovery sessions cannot be opened as user conversations.");
      if (branch && item.provider !== "claude-code") throw new Error("Explicit branch selection is only supported for Claude Code.");
      const retained = await readSession(item.source, item.session, branch ? { branchLeafId: branch.leafId, expectedBranchRevision: branch.revision } : {});
      const native = retained.preview.sessions.find((session) => session.sessionId === item.session.nativeSessionId);
      if (!native) throw new Error("Source history does not match the selected native session.");
      const instance = launch.instanceId;
      const shells = await deps.store.sessionShells();
      const owned = !branch ? matchingNativeHistorySession(shells, { id, source: item.source, session: item.session, provider: item.provider, instanceId: instance }) : undefined;
      const qualified = owned?.nativeAgent;
      const alreadyQualified = qualified?.provider === item.provider && qualified.instanceId === instance && qualified.sessionId === native.sessionId && qualified.cwd === item.session.cwd;
      const resume = !branch && item.session.cwd
        ? alreadyQualified || item.source.capabilities.nativeResume || await deps.canResume?.(item.provider, item.session.cwd)
        : false;
      const canResume = typeof resume === "object" ? resume.available : Boolean(resume);
      const readOnlyReason = branch
        ? "Read-only Claude branch snapshot. Open the original conversation to continue; this selected branch remains unchanged."
        : !item.session.cwd
          ? "This saved conversation does not record its original working folder. It can be inspected here, but cannot be safely resumed."
          : canResume ? null
            : typeof resume === "object" && resume.reason ? resume.reason
              : "This agent has not confirmed support for resuming the original session. Check its installation and login in Connections, then reopen this conversation.";
      const sessionId = owned?.id ?? `native-${projectionId}`;
      let session = owned ?? await deps.store.getSession(sessionId);
      const timestamp = item.session.updatedAt;
      if (!session) {
        session = SessionSchema.parse({ id: sessionId, experience: "work", provider: item.provider, title: `${item.session.title}${branch ? ` · Branch ${branch.leafId.slice(0, 8)}` : ""}`, appId: null, appName: null, cwd: item.session.cwd, codexThreadId: null, createdAt: timestamp, updatedAt: timestamp, status: "idle", pinned: false, archived: false, order: 0,
          nativeAgent: canResume ? { provider: item.provider, instanceId: instance, sessionId: native.sessionId, cwd: item.session.cwd! } : null,
          metadata: { nativeHistoryId: id, nativeHistoryProjection: true, nativeHistoryLoaded: true, sourceInstanceId: item.source.instanceId, sourceMachineId: item.source.machineId, nativeSource: item.source.source, nativeResumeAvailable: canResume, nativeSourceHash: native.contentHash, nativeReadOnlyReason: readOnlyReason, ...(branch ? { nativeBranch: branch } : {}) } });
        await deps.store.insertSessionAtFront(session);
        await deps.appendRuntimeEvent(event({ sessionId, name: "session.started", source: "server", data: { session, retainedHistory: true } }));
      }
      if (session.metadata?.nativeHistoryProjection && !session.nativeAgent && canResume && !session.metadata.nativeBranch) {
        const updated = await deps.store.updateSession(sessionId, (current) => ({ ...current, cwd: item.session.cwd, nativeAgent: { provider: item.provider, instanceId: instance, sessionId: native.sessionId, cwd: item.session.cwd! }, metadata: { ...current.metadata, nativeResumeAvailable: true, nativeReadOnlyReason: null } }));
        if (updated) { session = updated; await deps.appendRuntimeEvent(event({ sessionId, name: "session.updated", source: "server", data: { session, retainedHistory: true } })); }
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
      if (session.metadata?.nativeHistoryProjection && (session.metadata.nativeHistoryLoaded === false || session.metadata.nativeReadOnlyReason !== readOnlyReason)) {
        const updated = await deps.store.updateSession(sessionId, (current) => ({ ...current, metadata: { ...current.metadata,
          nativeHistoryLoaded: true, nativeSourceHash: native.contentHash,
          nativeResumeAvailable: canResume, nativeReadOnlyReason: readOnlyReason } }));
        if (updated) { session = updated; await deps.appendRuntimeEvent(event({ sessionId, name: "session.updated", source: "server", data: { session, retainedHistory: true } })); }
      }
      return session;
    })();
    opening.set(openingKey, operation); try { return await operation; } finally { opening.delete(openingKey); }
  }
  const handle = async (action: string, payload: unknown) => {
    if (action === "list") { const input = z.object({ cursors: z.record(z.string().max(200), z.string().max(4096)).optional(), retain: z.boolean().optional() }).parse(payload ?? {}); return list(input.cursors, input.retain); }
    if (action === "branches") {
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(payload);
      const item = await selection(id);
      return inspectSessionBranches(item.source, item.session);
    }
    if (action === "open") {
      const { id, branch } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), branch: z.object({ leafId: z.string().min(1).max(200), revision: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).parse(payload);
      return open(id, branch);
    }
    if (action === "collector") return handleNativeImporter(payload, deps.storeDir);
    throw new Error("Unknown native history action.");
  };
  // Discovery and opening share canonical session writes. A stale inventory must
  // never race another client into inserting the same source-qualified shell.
  let mutationQueue: Promise<unknown> = Promise.resolve();
  return (action: string, payload: unknown): Promise<unknown> => {
    const operation = mutationQueue.then(() => handle(action, payload));
    mutationQueue = operation.catch(() => undefined);
    return operation;
  };
}
