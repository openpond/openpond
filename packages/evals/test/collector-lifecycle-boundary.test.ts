import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCollector } from "../src/native-conversations/collector.js";
import { CollectorStore } from "../src/native-conversations/collector-store.js";
import type { CollectorConnection } from "../src/native-conversations/collector-contracts.js";

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
      revision: 3,
      state: "paused",
    });
    expect(store.status().connections[0]).toMatchObject({
      source: "pi",
      admitted: 1,
      queued: 0,
      backfill: { stage: "complete", total: 1, admitted: 1, failed: 0 },
    });
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
