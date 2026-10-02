import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCollector } from "../src/native-conversations/collector.js";
import { collectorDestinations, collectorDestinationLinks } from "../src/native-conversations/collector-destinations.js";
import { CollectorStore } from "../src/native-conversations/collector-store.js";
import type { CollectorConnection } from "../src/native-conversations/collector-contracts.js";
import { listSessions, readSession } from "../src/native-conversations/history.js";

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
    { type: "response_item", payload: { id: "request", type: "message", role: "user", content: "retained request" } },
    { type: "response_item", payload: { id: "answer", type: "message", role: "assistant", content: "retained answer" } },
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
    let resume: ReturnType<typeof setTimeout> | undefined;
    await runCollector({ directory: stateDirectory, signal: controller.signal, transport: {
      heartbeat: async current => {
        // Emulate an explicit control arriving after the paused startup scan.
        resume ??= setTimeout(() => store.put({ ...connection, revision: 3, state: "active" }), 50);
        return { revision: current.revision, state: current.state };
      },
      admit: async (_, entry) => {
        revisions++;
        expect(entry.operationId).not.toBe(prior.operationId);
        expect(entry.contentHash).toBe(session.contentHash);
        expect(entry.boundaryIds).toEqual([boundary.id]);
        expect(entry.files).toEqual(files);
      },
      pause: async () => { controller.abort(); return { revision: 4, state: "paused" }; },
    } });
    clearTimeout(resume);
    expect(revisions).toBe(1);
    expect(store.status().connections[0]).toMatchObject({ state: "paused", admitted: 1, queued: 0 });
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
        pause: async () => {
          controller.abort();
          return {
            revision: 3,
            state: "paused",
            source: "pi",
            projectId: "untrusted-extra",
          };
        },
      },
    });
    expect(admissions).toBe(1);
    expect(store.connections()[0]).toEqual({
      ...connection,
      destinations: destination,
      revision: 3,
      state: "paused",
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
            signal: controller.signal,
            transport: {
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
                controller.abort();
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
      let calls = 0;
      try {
        await runCollector({
          directory,
          signal: controller.signal,
          transport: {
            heartbeat: async (current, status) => {
              if (++calls === 2) controller.abort();
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
