import { watch } from "node:fs";
import { contentHash } from "@openpond/harness";
import { randomUUID } from "node:crypto";
import { listSessions, readSession } from "./history.js";
import { CollectorStore } from "./collector-store.js";
import {
  CollectorErrors,
  type CollectorErrorPhase,
} from "./collector-errors.js";
import { collectorBranchAnchor } from "./collector-branches.js";
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
  const errors = new CollectorErrors(store);
  function retained(connection: CollectorConnection) {
    return (
      store.connections().find((item) => item.id === connection.id) ??
      connection
    );
  }
  function applyRemote(
    connection: CollectorConnection,
    remote: Pick<CollectorConnection, "revision" | "state">,
  ) {
    const current = retained(connection);
    const next =
      current.state !== "disconnected" && remote.revision > current.revision
        ? { ...current, revision: remote.revision, state: remote.state }
        : current;
    store.put(next);
    return next;
  }
  function recordFailure(
    connection: CollectorConnection,
    error: unknown,
    phase: CollectorErrorPhase,
  ) {
    const message =
      error instanceof Error ? error.message : "Collection failed.";
    errors.set(connection.id, phase, message);
    const status =
      error && typeof error === "object" && "status" in error
        ? Number(error.status)
        : 0;
    const current = retained(connection);
    // Authentication loss requires explicit reconnection; a timer or restart
    // must never turn a revoked connection back into a paused/resumable one.
    if (current.state !== "disconnected" && [400, 401, 403].includes(status))
      store.put({
        ...current,
        state: status === 400 ? "paused" : "disconnected",
      });
  }
  async function acquire(connection: CollectorConnection) {
    let cursor: string | undefined;
    const failures: string[] = [];
    do {
      if (Date.now() - lastHeartbeat >= COLLECTOR_DEFAULTS.heartbeatMs) {
        lastHeartbeat = Date.now();
        store.set("heartbeatAt", new Date().toISOString());
        for (const current of store.connections()) {
          if (current.state === "disconnected") continue;
          try {
            const remote = await input.transport.heartbeat(current, {
              pendingOperations: store.queued(current.id),
              error: errors.message(current.id, "heartbeat"),
            });
            applyRemote(current, remote);
            errors.set(current.id, "heartbeat", null);
          } catch (error) {
            recordFailure(current, error, "heartbeat");
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
          const { files, preview, branchLeafId } = await readSession(
            connection.source,
            native,
            {
              branchAnchor: collectorBranchAnchor(
                store,
                connection.id,
                native.nativeSessionId,
              ),
            },
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
                  ...(branchLeafId ? { branchLeafId } : {}),
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
    errors.set(
      connection.id,
      "source",
      failures.length
        ? `${failures.length} session(s) need attention. ${failures[0]}`
        : null,
    );
  }
  try {
    while (
      !input.signal.aborted &&
      store.setting("desiredState") === "running"
    ) {
      const connections = store.connections();
      store.set("heartbeatAt", new Date().toISOString());
      for (const connection of connections) {
        if (connection.state === "disconnected") continue;
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
        connection = retained(connection);
        if (connection.state === "disconnected") continue;
        let phase: CollectorErrorPhase = "heartbeat";
        try {
          if (heartbeat) {
            const remote = await input.transport.heartbeat(connection, {
              pendingOperations: store.queued(connection.id),
              error: errors.message(connection.id, "heartbeat"),
            });
            connection = applyRemote(connection, remote);
            errors.set(connection.id, "heartbeat", null);
          }
          if (connection.state !== "active") continue;
          phase = "source";
          if (reconcile) await acquire(connection);
          connection =
            store.connections().find((item) => item.id === connection.id) ??
            connection;
          if (connection.state !== "active") continue;
          phase = "admission";
          const next = store.next(connection.id);
          if (next)
            try {
              await input.transport.admit(connection, next.entry);
              store.acknowledge(next.entry);
              errors.set(connection.id, "admission", null);
            } catch (error) {
              store.retry(next.entry.operationId, next.attempts);
              throw error;
            }
          if (
            !connection.keepSyncing &&
            store.queued(connection.id) === 0 &&
            store.progress.status(connection.id).stage === "complete" &&
            !errors.source(connection.id)
          ) {
            phase = "control";
            if (!input.transport.pause)
              throw new Error(
                "This transport cannot acknowledge completion of a one-time import.",
              );
            const paused = await input.transport.pause(connection);
            applyRemote(connection, paused);
            errors.set(connection.id, "control", null);
          }
        } catch (error) {
          recordFailure(connection, error, phase);
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
