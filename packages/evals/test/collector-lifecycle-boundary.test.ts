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
  await writeFile(file, [
    { type: "session", version: 3, id: "fixture", timestamp: at },
    { type: "message", id: "u", parentId: null, timestamp: at, message: { role: "user", content: "request" } },
    { type: "message", id: "a", parentId: "u", timestamp: at, message: { role: "assistant", content: "answer", stopReason: "stop" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  const connection: CollectorConnection = {
    id: "connection", teamId: "team", apiBaseUrl: "http://localhost",
    projectId: "project", revision: 1, since: null, keepSyncing: false, state: "active",
    source: { source: "pi", machineId: "machine", instanceId: "instance", root: file,
      acquisition: "files", available: true, capabilities: { history: true, live: true, nativeResume: true } },
  };
  const store = await CollectorStore.open(join(directory, "state"));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    store.put(connection);
    store.set("desiredState", "running");
    let admissions = 0;
    await runCollector({ directory: join(directory, "state"), signal: controller.signal, transport: {
      heartbeat: async () => ({ revision: 2, state: "active", source: "pi", projectId: "untrusted-extra" }),
      admit: async () => { admissions++; },
      pause: async () => {
        controller.abort();
        return { revision: 3, state: "paused", source: "pi", projectId: "untrusted-extra" };
      },
    } });
    expect(admissions).toBe(1);
    expect(store.connections()[0]).toEqual({ ...connection, revision: 3, state: "paused" });
    expect(store.status().connections[0]).toMatchObject({
      source: "pi", admitted: 1, queued: 0,
      backfill: { stage: "complete", total: 1, admitted: 1, failed: 0 },
    });
  } finally {
    clearTimeout(deadline);
    controller.abort();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
