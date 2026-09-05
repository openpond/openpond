import { snapshotInstructions } from "./instruction-snapshot.js";
import { promises as fs, realpathSync, watch } from "node:fs";
import path from "node:path";
import {
  resolveEffectiveConfig, assertConfigRunCurrent, getLocalRecord, putLocalRecord,
  effectivePreferences, type ConfigContext, type EffectiveConfig,
} from "@openpond/persistence";
import type { SendTurnRequest, Session } from "@openpond/contracts";
import { sessionUsesRepositoryWork } from "./experience-policy.js";

export async function admitTurnConfiguration(home: string, session: Session, input: SendTurnRequest, explicit: Record<string, unknown> = input) {
  let projectRoot = sessionUsesRepositoryWork(session) ? input.cwd ?? session.cwd : null;
  if (projectRoot) {
    // Discover only the repository root; nested directories do not add config layers.
    let candidate = await fs.realpath(projectRoot);
    while (true) {
      if (await fs.lstat(path.join(candidate, ".git")).catch(() => null)) { projectRoot = candidate; break; }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  const context: ConfigContext = {
    projectRoot,
    task: { schema_version: 1, ...(session.modelRef ? { chat: { model: { provider_id: session.modelRef.providerId, model_id: session.modelRef.modelId } } } : {}) },
    turn: { schema_version: 1,
      ...(input.modelRef || input.model ? { chat: { model: input.modelRef
        ? { provider_id: input.modelRef.providerId, model_id: input.modelRef.modelId }
        : { provider_id: session.modelRef?.providerId ?? session.provider, model_id: input.model! } } } : {}),
      ...(explicit.codexPermissionMode !== undefined ? { permissions: { codex_mode: input.codexPermissionMode } } : {}),
      ...(explicit.codexReasoningEffort !== undefined ? { codex: { reasoning_effort: input.codexReasoningEffort } } : {}),
    },
  };
  const snapshot = await resolveEffectiveConfig(home, context);
  const model = snapshot.document.chat?.model;
  // An existing provider-specific session keeps its provider. An inherited chat
  // model supplies the execution choice when the request has no explicit model.
  if (model && (input.modelRef || input.model || session.modelRef || session.provider === "openpond" || model.provider_id === session.provider)) {
    input.modelRef = { providerId: model.provider_id, modelId: model.model_id };
    input.model = model.model_id;
  }
  const instructions = await snapshotInstructions(home, snapshot.document, sessionUsesRepositoryWork(session) && session.workspaceKind === "local_project" ? input.cwd ?? session.cwd : null);
  return { context, snapshot, preferences: effectivePreferences(snapshot), instructions };
}
export function saveTurnConfiguration(home: string, turnId: string, admission: Awaited<ReturnType<typeof admitTurnConfiguration>>): void {
  putLocalRecord(home, "config_run_snapshots", turnId, { context: admission.context, snapshot: admission.snapshot, instructionSources: admission.instructions.sources, capturedAt: new Date().toISOString() }, null);
}
export async function assertTurnConfiguration(home: string | undefined, turnId: string): Promise<void> {
  if (!home) return;
  const record = getLocalRecord<{ context: ConfigContext; snapshot: EffectiveConfig }>(home, "config_run_snapshots", turnId);
  if (!record) throw new Error("Turn configuration snapshot is missing; start a new turn.");
  await assertConfigRunCurrent(home, record.value.snapshot, record.value.context);
}

/** Provider-owned tool loops are interrupted when a local authorization boundary changes. */
export function watchTurnConfiguration(home: string | undefined, turnId: string, projectRoot: string | null, revoke: (reason: string) => void): () => void {
  if (!home) return () => {};
  const directories = [home, path.join(home, "state"), path.join(home, "secrets"), ...(projectRoot ? [projectRoot, path.join(projectRoot, ".openpond")] : [])];
  const watchers = new Map<string, import("node:fs").FSWatcher>();
  let closed = false, checking = false, again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function check() {
    if (closed) return;
    if (checking) { again = true; return; }
    checking = true;
    attach();
    try { await assertTurnConfiguration(home, turnId); }
    catch (error) { if (!closed) { revoke(error instanceof Error ? error.message : String(error)); stop(); } }
    finally { checking = false; if (again && !closed) { again = false; schedule(); } }
  }
  function schedule() { if (!closed && !timer) { timer = setTimeout(() => { timer = undefined; void check(); }, 100); timer.unref(); } }
  function attach() {
    for (const directory of directories) if (!watchers.has(directory)) {
      try { const watcher = watch(realpathSync.native(directory), { persistent: false }, schedule); watcher.on("error", schedule); watchers.set(directory, watcher); } catch { /* The parent watch observes directory creation. Admission validated readable sources. */ }
    }
  }
  function stop() { closed = true; if (timer) clearTimeout(timer); for (const watcher of watchers.values()) watcher.close(); watchers.clear(); }
  attach();
  return stop;
}
