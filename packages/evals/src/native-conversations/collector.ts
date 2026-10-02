import { watch } from "node:fs";
import { contentHash } from "@openpond/harness";
import { randomUUID } from "node:crypto";
import { listSessions, readSession } from "./history.js";
import { CollectorStore } from "./collector-store.js";
import {
  COLLECTOR_DEFAULTS,
  type CollectorConnection,
  type CollectorTransport,
} from "./collector-contracts.js";

/** Supervised single owner: acquisition and admission checkpoints survive monitor/service exits. */
export async function runCollector(input: {
  directory: string;
  transport: CollectorTransport;
  signal: AbortSignal;
}) {
  const store = await CollectorStore.open(input.directory),
    nonce = randomUUID();
  store.database.exec("BEGIN IMMEDIATE");
  try {
    const retained = store.setting("owner");
    if (retained) {
      const owner = JSON.parse(retained) as { pid: number };
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) throw new Error("The collector already has a live owner.");
    }
    store.set("owner", JSON.stringify({ pid: process.pid, nonce }));
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    store.close();
    throw error;
  }
  if (store.setting("desiredState") !== "running") {
    store.set("owner", "");
    store.close();
    return;
  }
  store.set("pid", String(process.pid));
  let dirty = true,
    lastReconcile = 0,
    lastHeartbeat = 0;
  const watchers = new Map<string, ReturnType<typeof watch>>();
  const errors = new Map<string, string>();
  async function acquire(connection: CollectorConnection) {
    let cursor: string | undefined;
    const failures: string[] = [];
    do {
      if (Date.now() - lastHeartbeat >= COLLECTOR_DEFAULTS.heartbeatMs) {
        lastHeartbeat = Date.now();
        store.set("heartbeatAt", new Date().toISOString());
        for (let current of store.connections()) {
          try {
            const remote = await input.transport.heartbeat(current, {
              pendingOperations: store.queued(current.id),
              error: errors.get(current.id) ?? null,
            });
            if (remote.revision > current.revision)
              current = {
                ...current,
                revision: remote.revision,
                state: remote.state,
              };
            store.put(current);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Heartbeat failed";
            store.error(current.id, message);
          }
        }
      }
      connection =
        store.connections().find((item) => item.id === connection.id) ??
        connection;
      if (connection.state !== "active") return;
      if (input.signal.aborted || store.setting("desiredState") !== "running")
        return;
      const page = await listSessions(connection.source, {
        since: connection.since ?? undefined,
        cursor,
        limit: 50,
      });
      for (const native of page.items) {
        const scanKey = JSON.stringify([native.path, native.nativeSessionId]);
        store.progress.select(connection.id, scanKey);
        if (
          input.signal.aborted ||
          store.setting("desiredState") !== "running" ||
          store.connections().find((item) => item.id === connection.id)
            ?.state !== "active"
        )
          return;
        try {
          if (
            native.storageRevision &&
            !store.sourceChanged(
              connection.id,
              scanKey,
              native.storageRevision,
            ) &&
            !store.progress.tracks(connection.id, scanKey)
          )
            continue;
          const { files, preview } = await readSession(
            connection.source,
            native,
          );
          let eligible = false;
          for (const session of preview.sessions) {
            const key = JSON.stringify([
              connection.source.instanceId,
              session.sessionId,
              session.branchId,
            ]);
            store.progress.retained(connection.id, scanKey, key);
            const selectedBoundaries = session.boundaries.filter(
              (boundary) =>
                boundary.projection === "turn" &&
                boundary.terminal !== "unknown" &&
                (!connection.since ||
                  Date.parse(
                    session.events[boundary.start]!.occurredAt ??
                      native.updatedAt,
                  ) >= Date.parse(connection.since)),
            );
            eligible ||= selectedBoundaries.length > 0;
            const changed = selectedBoundaries.filter((boundary) =>
              store.changed(
                connection.id,
                key,
                boundary.id,
                contentHash([boundary.inputHash, boundary.revisionHash]),
              ),
            );
            for (
              let offset = 0;
              offset < changed.length;
              offset += COLLECTOR_DEFAULTS.batchCases
            ) {
              const selected = changed.slice(
                offset,
                offset + COLLECTOR_DEFAULTS.batchCases,
              );
              const operationId = `sync-${contentHash([connection.id, key, selected.map((boundary) => [boundary.id, boundary.inputHash, boundary.revisionHash])]).slice(0, 48)}`;
              store.enqueue(
                {
                  operationId,
                  connectionId: connection.id,
                  sessionKey: key,
                  contentHash: session.contentHash,
                  files,
                  boundaryIds: selected.map((boundary) => boundary.id),
                },
                selected.map((boundary) => ({
                  id: boundary.id,
                  revision: contentHash([
                    boundary.inputHash,
                    boundary.revisionHash,
                  ]),
                })),
                scanKey,
              );
            }
          }
          store.progress.read(connection.id, scanKey, eligible);
          if (native.storageRevision)
            store.scanned(connection.id, scanKey, native.storageRevision);
        } catch (error) {
          store.progress.failed(
            connection.id,
            scanKey,
            error instanceof Error ? error.message : "Unable to read session",
          );
          failures.push(
            `${native.nativeSessionId}: ${error instanceof Error ? error.message : "Unable to read session"}`,
          );
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    store.progress.discovered(connection.id);
    if (failures.length)
      errors.set(
        connection.id,
        `${failures.length} session(s) need attention. ${failures[0]}`,
      );
    else errors.delete(connection.id);
    store.error(connection.id, errors.get(connection.id) ?? null);
  }
  try {
    while (
      !input.signal.aborted &&
      store.setting("desiredState") === "running"
    ) {
      const connections = store.connections();
      store.set("heartbeatAt", new Date().toISOString());
      for (const connection of connections) {
        if (!watchers.has(connection.source.root))
          try {
            const watcher = watch(
              connection.source.root,
              { recursive: connection.source.acquisition !== "sqlite" },
              () => {
                dirty = true;
              },
            );
            watcher.on("error", () => {
              dirty = true;
            });
            watchers.set(connection.source.root, watcher);
          } catch {
            /* Reconciliation remains authoritative when platform watch is unavailable. */
          }
      }
      const heartbeat =
        Date.now() - lastHeartbeat >= COLLECTOR_DEFAULTS.heartbeatMs;
      if (heartbeat) lastHeartbeat = Date.now();
      const reconcile =
        dirty ||
        Date.now() - lastReconcile >= COLLECTOR_DEFAULTS.reconcileMs ||
        store.setting("syncNow") === "yes";
      if (reconcile) {
        dirty = false;
        lastReconcile = Date.now();
        store.set("syncNow", "no");
      }
      for (let connection of connections) {
        try {
          if (heartbeat) {
            const remote = await input.transport.heartbeat(connection, {
              pendingOperations: store.queued(connection.id),
              error: errors.get(connection.id) ?? null,
            });
            if (remote.revision > connection.revision)
              connection = {
                ...connection,
                revision: remote.revision,
                state: remote.state,
              };
            store.put(connection);
          }
          if (connection.state !== "active") continue;
          if (reconcile) await acquire(connection);
          connection =
            store.connections().find((item) => item.id === connection.id) ??
            connection;
          if (connection.state !== "active") continue;
          const next = store.next(connection.id);
          if (next)
            try {
              await input.transport.admit(connection, next.entry);
              store.acknowledge(next.entry);
              store.error(connection.id, errors.get(connection.id) ?? null);
            } catch (error) {
              store.retry(next.entry.operationId, next.attempts);
              throw error;
            }
          if (
            !connection.keepSyncing &&
            store.queued(connection.id) === 0 &&
            store.progress.status(connection.id).stage === "complete" &&
            !errors.has(connection.id)
          ) {
            if (!input.transport.pause)
              throw new Error(
                "This transport cannot acknowledge completion of a one-time import.",
              );
            const paused = await input.transport.pause(connection);
            store.put({
              ...connection,
              revision: paused.revision,
              state: paused.state,
            });
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Collection failed.";
          errors.set(connection.id, message);
          store.error(connection.id, message);
          const status =
            error && typeof error === "object" && "status" in error
              ? Number(error.status)
              : 0;
          if (status === 401 || status === 403 || status === 400)
            store.put({ ...connection, state: "paused" });
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        input.signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    for (const watcher of watchers.values()) watcher.close();
    const owner = JSON.parse(store.setting("owner") || "{}") as {
      nonce?: string;
    };
    if (owner.nonce === nonce) {
      store.set("pid", "");
      store.set("heartbeatAt", "");
      store.set("owner", "");
    }
    store.close();
  }
}
