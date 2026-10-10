import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runCollector } from "../src/native-conversations/collector.js";
import { collectorDestinations, collectorDestinationLinks } from "../src/native-conversations/collector-destinations.js";
import { CollectorStore } from "../src/native-conversations/collector-store.js";
import type { CollectorConnection } from "../src/native-conversations/collector-contracts.js";
import { listSessions, readSession } from "../src/native-conversations/history.js";

// Failure story: a real empty OpenCode session permanently poisons the collector
// as a source failure, or skipping it prevents its later completed turn admission.
it("skips empty OpenCode history and admits the same identity once it has a completed request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-empty-opencode-"));
  const database = new DatabaseSync(join(directory, "opencode.db"));
  database.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,parent_id TEXT,version TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER);
    INSERT INTO session VALUES('original','QA conversation','/workspace',NULL,'test',1000,1000);
  `);
  const stateDirectory = join(directory, "state");
  const store = await CollectorStore.open(stateDirectory);
  const connection: CollectorConnection = { id: "empty", teamId: "team", projectId: "project", apiBaseUrl: "http://localhost", revision: 1,
    since: null, keepSyncing: false, state: "active", source: { source: "opencode", root: directory, machineId: "machine", instanceId: "instance",
      acquisition: "sqlite", available: true, capabilities: { history: true, live: true, nativeResume: false } } };
  let admissions = 0;
  async function scan(revision: number) {
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000);
    store.put({ ...connection, revision }); store.set("desiredState", "running");
    try {
      await runCollector({ directory: stateDirectory, signal: controller.signal, transport: {
        publishCoverage: async () => {},
        heartbeat: async current => ({ revision: current.revision, state: current.state }),
        admit: async (_, entry) => { admissions++; expect(JSON.parse(entry.files[0]!.text).info.id).toBe("original"); },
      } });
    } finally { clearTimeout(deadline); controller.abort(); }
  }
  try {
    await scan(1);
    expect(admissions).toBe(0);
    expect(store.status().connections[0]).toMatchObject({ error: null, backfill: { skipped: 1, failed: 0 } });
    const insertMessage = database.prepare("INSERT INTO message VALUES(?,?,?,?,?)"), insertPart = database.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)");
    for (const [id, role, text] of [["request", "user", "Explain the tradeoff"], ["answer", "assistant", "Use the simpler design"]]) {
      insertMessage.run(id!, "original", JSON.stringify({ role, time: { created: role === "user" ? 2000 : 3000 }, ...(role === "assistant" ? { finish: "stop" } : {}) }), role === "user" ? 2000 : 3000, 3000);
      insertPart.run(`${id}-text`, "original", id!, JSON.stringify({ type: "text", text }), 3000, 3000);
    }
    database.exec("UPDATE session SET time_updated=3000 WHERE id='original'");
    await scan(3);
    expect(admissions).toBe(1);
    expect(store.status().connections[0]).toMatchObject({ error: null, admitted: 1, queued: 0 });
  } finally { database.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

// A parser privacy correction must invalidate the old mtime cache and create a
// new immutable revision, while preserving already admitted task identities.
// A resumed once-only source must not auto-pause from old completed progress
// before its next scheduled reconciliation.
it("reprojects an unchanged Codex file after a source-policy upgrade", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-normalizer-upgrade-"));
  const file = join(directory, "rollout.jsonl");
  await writeFile(file, [
    { type: "session_meta", payload: { id: "policy-upgrade", cli_version: "0.153.4" } },
    { type: "world_state", payload: { state: { permissions: { approved_command_prefixes: [["token=fixtureAuthorization123"]] } } } },
    { type: "response_item", timestamp: "2026-10-02T00:00:01Z", payload: { id: "request", type: "message", role: "user", content: "retained request" } },
    { type: "response_item", timestamp: "2026-10-02T00:00:02Z", payload: { id: "answer", type: "message", role: "assistant", content: "retained answer" } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  const connection: CollectorConnection = {
    id: "upgrade", teamId: "team", apiBaseUrl: "http://localhost", projectId: "project",
    revision: 2, since: null, keepSyncing: false, state: "paused",
    source: { source: "codex", machineId: "machine", instanceId: "instance", root: file,
      acquisition: "files", available: true, capabilities: { history: true, live: true, nativeResume: false } },
  };
  const native = (await listSessions(connection.source, {})).items[0]!;
  const { files, preview } = await readSession(connection.source, native);
  const session = preview.sessions[0]!, boundary = session.boundaries.find(item => item.projection === "turn")!;
  const scanKey = JSON.stringify([native.path, native.nativeSessionId]);
  const sessionKey = JSON.stringify([connection.source.instanceId, session.sessionId, session.branchId]);
  const stateDirectory = join(directory, "state"), store = await CollectorStore.open(stateDirectory);
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000);
  try {
    store.put(connection); store.set("desiredState", "running");
    const prior = { operationId: "old-normalizer-operation", connectionId: connection.id, sessionKey,
      contentHash: "old-normalizer-snapshot", files, boundaryIds: [boundary.id] };
    store.enqueue(prior, [{ id: boundary.id, revision: "old-normalizer-boundary" }]);
    store.acknowledge(prior);
    store.scanned(connection.id, scanKey, native.storageRevision!);
    store.progress.select(connection.id, scanKey); store.progress.read(connection.id, scanKey, true); store.progress.discovered(connection.id);
    let revisions = 0;
    await runCollector({ directory: stateDirectory, signal: controller.signal, transport: {
      publishCoverage: async () => {},
      heartbeat: async current => {
        // An explicit remote resume is observed at this job's first probe.
        return { revision: Math.max(3, current.revision), state: "active" };
      },
      admit: async (_, entry) => {
        revisions++;
        expect(entry.operationId).not.toBe(prior.operationId);
        expect(entry.contentHash).toBe(session.contentHash);
        expect(entry.boundaryIds).toEqual([boundary.id]);
        expect(entry.files).toEqual(files);
      },
    } });
    expect(revisions).toBe(1);
    expect(store.status().connections[0]).toMatchObject({ state: "active", admitted: 1, queued: 0, run: { state: "completed" } });
    expect((await listSessions(connection.source, {})).items[0]?.storageRevision).toBe(native.storageRevision);
  } finally { clearTimeout(deadline); controller.abort(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

// Failure story: a richer hosted control DTO replaces the local NativeSource with
// its source-name string, erasing acknowledged progress and breaking resumption.
it("preserves local source identity and receipts across remote controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-control-"));
  const file = join(directory, "session.jsonl");
  const at = "2026-10-02T00:00:00.000Z";
  await writeFile(
    file,
    [
      { type: "session", version: 3, id: "fixture", timestamp: at },
      {
        type: "message",
        id: "u",
        parentId: null,
        timestamp: at,
        message: { role: "user", content: "request" },
      },
      {
        type: "message",
        id: "a",
        parentId: "u",
        timestamp: at,
        message: { role: "assistant", content: "answer", stopReason: "stop" },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const connection: CollectorConnection = {
    id: "connection",
    teamId: "team",
    apiBaseUrl: "http://localhost",
    accountBaseUrl: "https://staging.openpond.ai",
    projectId: "project",
    revision: 1,
    since: null,
    keepSyncing: false,
    state: "active",
    source: {
      source: "pi",
      machineId: "machine",
      instanceId: "instance",
      root: file,
      acquisition: "files",
      available: true,
      capabilities: { history: true, live: true, nativeResume: true },
    },
  };
  const destination = collectorDestinations(connection, {
    id: connection.id, teamId: connection.teamId, projectId: connection.projectId,
    machineId: connection.source.machineId, sourceInstanceId: connection.source.instanceId,
    sourceRoot: connection.source.root, source: connection.source.source,
    taskDatasetId: "task/dataset", conversationDatasetId: null,
  });
  // No link is manufactured before the server returns a destination; a foreign
  // scope or credential-bearing/unsafe origin must never become a Desktop link.
  expect(collectorDestinationLinks(connection).tasks).toBeNull();
  const destinationUrl = new URL(collectorDestinationLinks({ ...connection, destinations: destination, accountBaseUrl: "https://staging.openpond.ai" }).tasks!);
  expect(destinationUrl.searchParams.get("project")).toBe(connection.projectId);
  expect(destinationUrl.searchParams.get("connection")).toBe(connection.id);
  expect(decodeURIComponent(destinationUrl.pathname)).toBe("/console/datasets/task/dataset/tasks");
  expect(() => collectorDestinations(connection, {
    id: connection.id, teamId: "another-team", projectId: connection.projectId,
    machineId: connection.source.machineId, sourceInstanceId: connection.source.instanceId,
    sourceRoot: connection.source.root, source: connection.source.source, ...destination,
  })).toThrow(/another source or workspace/);
  expect(collectorDestinationLinks({ ...connection, destinations: destination, accountBaseUrl: "https://user:secret@example.com" }).tasks).toBeNull();
  expect(collectorDestinationLinks({ ...connection, destinations: destination, accountBaseUrl: "javascript:alert(1)" }).tasks).toBeNull();
  const store = await CollectorStore.open(join(directory, "state"));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    store.put(connection);
    store.set("desiredState", "running");
    let admissions = 0;
    await runCollector({
      directory: join(directory, "state"),
      signal: controller.signal,
      transport: {
        publishCoverage: async () => {},
        heartbeat: async () => ({
          revision: 2,
          state: "active",
          source: "pi",
          projectId: "untrusted-extra",
          destinations: destination,
        }),
        admit: async () => {
          admissions++;
        },

      },
    });
    expect(admissions).toBe(1);
    expect(store.connections()[0]).toEqual({
      ...connection,
      destinations: destination,
      revision: 2,
      state: "active",
      requestedSyncRevision: 0,
      completedSyncRevision: 0,
    });
    expect(store.status().connections[0]).toMatchObject({
      source: "pi",
      destinationLinks: { tasks: "https://staging.openpond.ai/console/datasets/task%2Fdataset/tasks?project=project&connection=connection", conversations: null },
      admitted: 1,
      queued: 0,
      backfill: { stage: "complete", total: 1, admitted: 1, failed: 0 },
    });
    store.put({ ...store.connections()[0]!, revision: 4, projectId: "another-project" });
    expect(store.status().connections[0]?.destinationLinks.tasks).toBeNull();
  } finally {
    clearTimeout(deadline);
    controller.abort();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// A heartbeat is not a completed sync. Requests arriving after acquisition,
// paused/stopped collection, and a lost completion ACK must not create a false
// success or lose durable work when the collector restarts.
it("acknowledges requested sync only after acquisition and admission, across controls and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-requested-sync-"));
  const sourceRoot = join(directory, "source");
  await mkdir(sourceRoot);
  const transcript = (id: string) => [
    { type: "session", version: 3, id, timestamp: "2026-10-02T00:00:00Z" },
    { type: "message", id: "u", parentId: null, timestamp: "2026-10-02T00:00:01Z", message: { role: "user", content: "retained request" } },
    { type: "message", id: "a", parentId: "u", timestamp: "2026-10-02T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "retained answer" }], stopReason: "stop" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(join(sourceRoot, "first.jsonl"), transcript("first"));
  const state = join(directory, "state"), store = await CollectorStore.open(state);
  const connection: CollectorConnection = {
    id: "requested", teamId: "team", projectId: "project", apiBaseUrl: "http://localhost",
    revision: 2, requestedSyncRevision: 2, completedSyncRevision: 0,
    state: "paused", since: null, keepSyncing: false,
    source: { source: "pi", machineId: "machine", instanceId: "instance", root: sourceRoot,
      acquisition: "files", available: true, capabilities: { history: true, live: true, nativeResume: false } },
  };
  let admissions = 0, acknowledged = 0;
  try {
    store.put(connection); store.set("desiredState", "running");
    const paused = new AbortController();
    await runCollector({ directory: state, signal: paused.signal, transport: {
      publishCoverage: async () => {},
      heartbeat: async current => { paused.abort(); return { revision: current.revision, state: "paused", requestedSyncRevision: 2, completedSyncRevision: 0 }; },
      admit: async () => { throw new Error("Paused source admitted work"); },
    } });
    expect(store.status().connections[0]).toMatchObject({ state: "paused", admitted: 0, completedSyncRevision: 0 });
    store.put({ ...connection, state: "active" }); store.set("desiredState", "stopped");
    await runCollector({ directory: state, signal: new AbortController().signal, transport: {
      publishCoverage: async () => {},
      heartbeat: async () => { throw new Error("Stopped collector contacted remote"); },
      admit: async () => { throw new Error("Stopped collector admitted work"); },
    } });
    store.set("desiredState", "running");
    const first = new AbortController(), deadline = setTimeout(() => first.abort(), 8000);
    try {
      await runCollector({ directory: state, signal: first.signal, transport: {
        publishCoverage: async () => {},
        heartbeat: async (current, report) => {
          if (report.completedSyncRevision) {
            expect(report.completedSyncRevision).toBe(3);
            expect(admissions).toBe(2);
            expect(report.pendingOperations).toBe(0);
            expect(report.error).toBeNull();
            acknowledged = 3;
            first.abort();
            throw new Error("Completion committed remotely; response lost");
          }
          return { revision: current.revision, state: "active", requestedSyncRevision: current.requestedSyncRevision, completedSyncRevision: acknowledged };
        },
        admit: async current => {
          admissions++;
          if (admissions === 1) {
            await writeFile(join(sourceRoot, "second.jsonl"), transcript("second"));
            store.put({ ...current, revision: 3, requestedSyncRevision: 3 });
          }
        },
      } });
    } finally { clearTimeout(deadline); first.abort(); }
    expect(acknowledged).toBe(3);
    expect(store.status().connections[0]).toMatchObject({ admitted: 2, queued: 0, completedSyncRevision: 3, acknowledgedSyncRevision: 0 });
    // A stale local writer cannot erase completion before the restart reports it.
    store.put({ ...connection, state: "active", revision: 3, requestedSyncRevision: 3 });
    expect(store.connections()[0]!.completedSyncRevision).toBe(3);
    const restart = new AbortController(), restartDeadline = setTimeout(() => restart.abort(), 5000);
    try {
      await runCollector({ directory: state, trigger: "manual", signal: restart.signal, transport: {
        publishCoverage: async () => {},
        heartbeat: async (current, report) => {
          expect(report.completedSyncRevision).toBe(3);
          expect(report.error).toBeNull();
          return { revision: current.revision, state: "active", requestedSyncRevision: 3, completedSyncRevision: acknowledged };
        },
        admit: async () => { throw new Error("Restart duplicated an acknowledged admission"); },
      } });
    } finally { clearTimeout(restartDeadline); restart.abort(); }
    expect(store.status().connections[0]).toMatchObject({ state: "active", admitted: 2, queued: 0, completedSyncRevision: 3, acknowledgedSyncRevision: 3, error: null, run: { state: "completed" } });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);

// Failure story: revocation retries forever, or a late HTTP rejection overwrites
// Disconnect with Pause and a restarted service resumes collection.
it.each([401, 403])(
  "retains disconnect across HTTP %s and service restart",
  async (status) => {
    const directory = await mkdtemp(join(tmpdir(), "collector-revocation-"));
    const store = await CollectorStore.open(directory);
    const connection: CollectorConnection = {
      id: "revoked",
      teamId: "team",
      apiBaseUrl: "http://localhost",
      projectId: "project",
      revision: 1,
      since: null,
      keepSyncing: true,
      state: "active",
      source: {
        source: "pi",
        machineId: "machine",
        instanceId: "instance",
        root: directory,
        acquisition: "files",
        available: true,
        capabilities: { history: true, live: true, nativeResume: true },
      },
    };
    try {
      store.put(connection);
      store.put({ ...connection, id: "disconnected", state: "disconnected" });
      store.put({ ...connection, id: "other", state: "paused" });
      store.set("desiredState", "running");
      const heartbeats: string[] = [];
      let admissions = 0;
      for (let restart = 0; restart < 2; restart++) {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 5000);
        try {
          await runCollector({
            directory,
            trigger: "manual",
            signal: controller.signal,
            transport: {
              publishCoverage: async () => {},
              heartbeat: async (current) => {
                heartbeats.push(current.id);
                if (current.id === "revoked") {
                  if (status === 403)
                    store.put({
                      ...current,
                      revision: 2,
                      state: "disconnected",
                    });
                  throw Object.assign(new Error("Credential revoked"), {
                    status,
                  });
                }
                return { revision: current.revision, state: current.state };
              },
              admit: async () => {
                admissions++;
              },
            },
          });
        } finally {
          clearTimeout(deadline);
          controller.abort();
        }
      }
      expect(heartbeats.sort()).toEqual(["other", "other", "revoked"]);
      expect(admissions).toBe(0);
      expect(
        store.connections().find((item) => item.id === "revoked"),
      ).toMatchObject({
        state: "disconnected",
        revision: status === 403 ? 2 : 1,
      });
      expect(
        store.connections().find((item) => item.id === "other"),
      ).toMatchObject({ state: "paused" });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// Failure story: a recovered heartbeat leaves a rollout outage visible forever,
// or clearing it hides an unresolved native-history read failure after restart.
it("clears recovered heartbeat failures while retaining source failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-heartbeat-"));
  const store = await CollectorStore.open(directory);
  const connection: CollectorConnection = {
    id: "healthy",
    teamId: "team",
    apiBaseUrl: "http://localhost",
    projectId: "project",
    revision: 1,
    since: null,
    keepSyncing: true,
    state: "paused",
    source: {
      source: "pi",
      machineId: "machine",
      instanceId: "instance",
      root: directory,
      acquisition: "files",
      available: true,
      capabilities: { history: true, live: true, nativeResume: true },
    },
  };
  try {
    store.put(connection);
    store.put({ ...connection, id: "unreadable" });
    store.progress.select("unreadable", "session");
    store.progress.failed(
      "unreadable",
      "session",
      "Native session is unreadable",
    );
    store.set("desiredState", "running");
    const reported = new Map<string, string | null>();
    for (let restart = 0; restart < 2; restart++) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 5000);
      try {
        await runCollector({
          directory,
          trigger: "manual",
          signal: controller.signal,
          transport: {
            publishCoverage: async () => {},
            heartbeat: async (current, status) => {
              if (restart === 0)
                throw Object.assign(new Error("Sync request failed (502)."), {
                  status: 502,
                });
              reported.set(current.id, status.error);
              return { revision: current.revision, state: current.state };
            },
            admit: async () => {
              throw new Error("Paused source must not upload");
            },
          },
        });
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
      if (restart === 0)
        expect(
          store.status().connections.find((item) => item.id === "healthy")
            ?.error,
        ).toContain("502");
    }
    expect(reported.get("healthy")).toBeNull();
    expect(reported.get("unreadable")).toContain(
      "Native session is unreadable",
    );
    expect(
      store.status().connections.find((item) => item.id === "healthy")?.error,
    ).toBeNull();
    expect(
      store.status().connections.find((item) => item.id === "unreadable")
        ?.error,
    ).toContain("Native session is unreadable");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
