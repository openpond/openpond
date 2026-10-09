import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CollectorStore } from "./collector-store.js";
import { CollectorErrors, type CollectorErrorPhase } from "./collector-errors.js";
import { CollectorSyncRequests } from "./collector-sync-requests.js";
import { acquireCollectorSource, CollectorInterruptedError, CollectorScopeChangedError } from "./collector-acquisition.js";
import { scheduledSyncDue, scheduledMinute } from "./collector-schedule.js";
import { COLLECTOR_DEFAULTS, type CollectorConnection, type CollectorTransport, type CollectorRemoteControl, type CollectorRun } from "./collector-contracts.js";

/** A single owned, bounded job. No filesystem watchers or idle network polling. */
export async function runCollector(input: {
  directory: string;
  transport: CollectorTransport;
  signal: AbortSignal;
  connectionIds?: string[];
  trigger?: "manual" | "scheduled";
  maxDurationMs?: number;
}) {
  const store = await CollectorStore.open(input.directory), nonce = randomUUID();
  let selected: CollectorConnection[] = [];
  store.database.exec("BEGIN IMMEDIATE");
  try {
    const retainedOwner = store.setting("owner");
    if (retainedOwner) {
      const owner = JSON.parse(retainedOwner) as { pid: number };
      let alive = true;
      try { process.kill(owner.pid, 0); }
      catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (alive) {
        if (input.trigger === "scheduled") { store.database.exec("COMMIT"); store.close(); return; }
        throw new Error("An import is already running. Cancel it or wait for it to finish.");
      }
    }
    const now = new Date();
    selected = store.connections().filter(connection => connection.state !== "disconnected" &&
      (!input.connectionIds || input.connectionIds.includes(connection.id)) &&
      (input.trigger !== "scheduled" || (connection.state === "active" && scheduledSyncDue(store.schedule(connection.id), store.setting(`scheduledMinute:${connection.id}`), now))));
    if (input.trigger === "scheduled")
      for (const connection of selected) store.set(`scheduledMinute:${connection.id}`, scheduledMinute(now));
    if (selected.length && input.trigger) store.set("desiredState", "running");
    if (!selected.length || store.setting("desiredState") !== "running" || input.signal.aborted) {
      store.database.exec("COMMIT"); store.close(); return;
    }
    store.set("owner", JSON.stringify({ pid: process.pid, nonce }));
    store.set("pid", String(process.pid));
    store.set("heartbeatAt", now.toISOString());
    store.database.exec("COMMIT");
  } catch (error) { store.database.exec("ROLLBACK"); store.close(); throw error; }

  const controller = new AbortController();
  const deadlineAt = Date.now() + (input.maxDurationMs ?? COLLECTOR_DEFAULTS.runMs);
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const deadline = setTimeout(() => controller.abort(new Error("Import exceeded its one-hour time budget. Remaining work is retained for the next run.")), input.maxDurationMs ?? COLLECTOR_DEFAULTS.runMs);
  // Local cancellation also interrupts an in-flight HTTP request.
  const pulse = setInterval(() => {
    if (store.setting("desiredState") !== "running") controller.abort(new CollectorInterruptedError("Import cancelled."));
    else store.set("heartbeatAt", new Date().toISOString());
  }, 250);
  const errors = new CollectorErrors(store), syncRequests = new CollectorSyncRequests(store);
  const retained = (connection: CollectorConnection) => store.connections().find(item => item.id === connection.id) ?? connection;
  const heartbeatInput = (connection: CollectorConnection) => {
    const pendingOperations = store.queued(connection.id), error = errors.message(connection.id, "heartbeat");
    return { pendingOperations, error, completedSyncRevision: !pendingOperations && !error ? connection.completedSyncRevision ?? 0 : 0 };
  };
  function applyRemote(connection: CollectorConnection, remote: CollectorRemoteControl) {
    const current = retained(connection);
    if (current.state === "disconnected" || remote.revision < current.revision) return current;
    const sync = syncRequests.observe(current, remote);
    if (remote.revision > current.revision) errors.set(current.id, "control", null);
    const next = { ...current, ...sync, ...(remote.revision > current.revision ? { revision: remote.revision, state: remote.state } : {}), ...(remote.destinations ? { destinations: remote.destinations } : {}) };
    store.put(next); return next;
  }
  function recordFailure(connection: CollectorConnection, error: unknown, phase: CollectorErrorPhase) {
    errors.set(connection.id, phase, error instanceof Error ? error.message : "Import failed.");
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    const current = retained(connection);
    if (current.state !== "disconnected" && [400, 401, 403].includes(status))
      store.put({ ...current, state: status === 400 ? "paused" : "disconnected" });
  }
  function checkCancelled() {
    if (Date.now() >= deadlineAt && !controller.signal.aborted) controller.abort(new Error("Import time budget reached. Remaining work is retained for the next run."));
    if (signal.aborted) throw signal.reason ?? new CollectorInterruptedError("Import cancelled.");
    if (store.setting("desiredState") !== "running") throw new CollectorInterruptedError("Import cancelled.");
  }
  try {
    await store.snapshots.migrate(() => signal.aborted || Date.now() >= deadlineAt || store.setting("desiredState") !== "running");
    for (let connection of selected) {
      let phase: CollectorErrorPhase = "heartbeat", lastHeartbeat = 0;
      let run: CollectorRun = { id: nonce, state: "running", phase: "discovering", startedAt: new Date().toISOString(), finishedAt: null, processed: 0, discovered: 0, uploaded: 0, error: null };
      const progress = (update: Partial<CollectorRun>) => { run = { ...run, ...update }; store.set(`run:${connection.id}`, JSON.stringify(run)); };
      progress({});
      const heartbeat = async () => {
        checkCancelled();
        phase = "heartbeat";
        connection = retained(connection);
        const remote = await input.transport.heartbeat(connection, heartbeatInput(connection), signal);
        connection = applyRemote(connection, remote);
        errors.set(connection.id, "heartbeat", null);
        lastHeartbeat = Date.now();
      };
      const check = async () => {
        checkCancelled();
        if (Date.now() - lastHeartbeat >= COLLECTOR_DEFAULTS.heartbeatMs) await heartbeat();
        connection = retained(connection);
        if (connection.state !== "active") throw new CollectorInterruptedError(`Source ${connection.state}.`);
      };
      const drain = async () => {
        while (store.queued(connection.id)) {
          await check();
          const next = store.next(connection.id);
          if (!next) break;
          progress({ phase: "uploading" });
          let admitted = false;
          for (let attempt = 0; attempt < COLLECTOR_DEFAULTS.attemptsPerRun; attempt++) {
            await check();
            if (!store.database.prepare("SELECT 1 FROM pending WHERE id=? AND connection_id=?").get(next.entry.operationId, connection.id)) {
              admitted = true;
              break;
            }
            phase = "admission";
            try {
              await input.transport.admit(connection, next.entry, signal);
              // Retain a real receipt even if Cancel arrived while the server committed.
              store.acknowledge(next.entry);
              errors.set(connection.id, "admission", null);
              progress({ uploaded: run.uploaded + next.entry.boundaryIds.length });
              admitted = true; break;
            } catch (error) {
              store.retry(next.entry.operationId, next.attempts + attempt);
              const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
              if (signal.aborted || [400, 401, 403, 409].includes(status) || attempt + 1 >= COLLECTOR_DEFAULTS.attemptsPerRun) throw error;
              await delay(1000 * 2 ** attempt, undefined, { signal });
            }
          }
          if (!admitted) throw new Error("Pending import was not acknowledged.");
        }
      };
      try {
        await heartbeat();
        if (connection.state !== "active") throw new CollectorInterruptedError(`Source ${connection.state}.`);
        await drain();
        let completedRevision: number | undefined;
        // Remote scope revisions arriving mid-job require a fresh acquisition
        // before acknowledging that request. Bound concurrent reconfiguration.
        for (let pass = 0; pass < 3; pass++) {
          await check();
          const revision = connection.revision, requested = connection.requestedSyncRevision ?? 0;
          phase = "source";
          const checkAcquisition = async () => {
            await check(); phase = "source";
            if (connection.revision !== revision) throw new CollectorScopeChangedError("Source settings changed during acquisition.");
          };
          try {
            await acquireCollectorSource({ store, connection, check: checkAcquisition,
              drain: async () => { await drain(); await checkAcquisition(); }, progress });
          } catch (error) {
            if (error instanceof CollectorScopeChangedError && pass < 2) continue;
            throw error;
          }
          errors.set(connection.id, "source", null);
          await drain();
          connection = retained(connection);
          if (connection.revision !== revision) {
            if (pass === 2) throw new Error("Source settings changed repeatedly during import. Run Sync now again.");
            continue;
          }
          syncRequests.acquired(connection.id, { controlRevision: revision, requestedSyncRevision: requested, succeeded: true });
          connection = syncRequests.complete(connection, errors.message(connection.id, "heartbeat"));
          await heartbeat();
          if (connection.revision !== revision || syncRequests.needsAcquisition(connection)) {
            if (pass === 2) throw new Error("Source settings changed during completion. Run Sync now again.");
            continue;
          }
          if (syncRequests.needsAcknowledgement(connection)) throw new Error("The server has not acknowledged sync completion. Retry with Sync now.");
          completedRevision = revision;
          break;
        }
        await check();
        if (connection.revision !== completedRevision) throw new CollectorScopeChangedError("Source settings changed before completion. Run Sync now again.");
        progress({ state: "completed", finishedAt: new Date().toISOString() });
        store.set(`lastSuccess:${connection.id}`, run.finishedAt!);
      } catch (error) {
        const cancelled = error instanceof CollectorInterruptedError || input.signal.aborted || signal.reason instanceof CollectorInterruptedError;
        const reason = signal.aborted ? signal.reason : error;
        const message = reason instanceof Error ? reason.message : "Import cancelled.";
        if (!cancelled) recordFailure(connection, reason, phase);
        progress({ state: cancelled ? "cancelled" : "failed", error: message, finishedAt: new Date().toISOString() });
      }
      if (signal.aborted || store.setting("desiredState") !== "running") break;
    }
  } finally {
    clearInterval(pulse); clearTimeout(deadline);
    const owner = JSON.parse(store.setting("owner") || "{}") as { nonce?: string };
    if (owner.nonce === nonce) {
      store.set("pid", ""); store.set("heartbeatAt", ""); store.set("owner", ""); store.set("desiredState", "stopped");
    }
    store.close();
  }
}
