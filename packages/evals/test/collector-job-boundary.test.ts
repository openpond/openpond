import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { CollectorStore } from "../src/native-conversations/collector-store.js";
import { runCollector } from "../src/native-conversations/collector.js";
import { scheduledSyncDue, scheduledMinute, nextScheduledSync } from "../src/native-conversations/collector-schedule.js";
import { collectorServiceFiles } from "../src/native-conversations/collector-service-files.js";
import type { CollectorConnection, CollectorAdmission } from "../src/native-conversations/collector-contracts.js";
import { summarizeCollectorCoverage, type CollectorCoverageManifest } from "../src/connected-evidence/collector-coverage-contracts.js";

const connection = (root: string): CollectorConnection => ({ id: "source", projectId: "project", teamId: "team", apiBaseUrl: "https://example.test", revision: 1, since: null, keepSyncing: false, state: "active",
  source: { source: "pi", root, machineId: "machine", instanceId: "instance", acquisition: "files", available: true, capabilities: { history: true, live: true, nativeResume: false } } });
const transcript = [
  { type: "session", version: 3, id: "conversation", timestamp: "2026-10-02T00:00:00Z" },
  { type: "message", id: "u", parentId: null, timestamp: "2026-10-02T00:00:01Z", message: { role: "user", content: "A durable request" } },
  { type: "message", id: "a", parentId: "u", timestamp: "2026-10-02T00:00:02Z", message: { role: "assistant", content: "A durable answer", stopReason: "stop" } },
].map(row => JSON.stringify(row)).join("\n") + "\n";

// Failure story: a moving cutoff or guessed timestamp declares complete study
// coverage even though a requested turn was omitted or newer work was admitted.
test("retains fixed-window coverage and refuses to certify unknown event times", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-window-"));
  const file = join(root, "conversation.jsonl"), directory = join(root, "state");
  const rows = transcript.trim().split("\n").map(row => JSON.parse(row));
  rows.push({ type: "message", id: "u2", parentId: "a", timestamp: "2026-10-04T00:00:00Z", message: { role: "user", content: "Newer request" } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-10-04T00:00:01Z", message: { role: "assistant", content: "Newer answer", stopReason: "stop" } });
  const store = await CollectorStore.open(directory);
  let admitted = 0;
  const manifests: CollectorCoverageManifest[] = [];
  const transport = { heartbeat: async (current: CollectorConnection) => ({ revision: current.revision, state: current.state }),
    admit: async (_: CollectorConnection, entry: CollectorAdmission) => { admitted += entry.boundaryIds.length; },
    publishCoverage: async (_: CollectorConnection, manifest: CollectorCoverageManifest) => { manifests.push(manifest); } };
  try {
    store.put({ ...connection(file), since: "2026-10-01T00:00:00Z" });
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const scan = () => runCollector({ directory, signal: new AbortController().signal, trigger: "manual",
      until: "2026-10-03T00:00:00Z", transport });
    await scan();
    expect(admitted).toBe(1);
    expect(summarizeCollectorCoverage(manifests.at(-1)!)).toMatchObject({ complete: true, eligibleTurns: 1, pendingOperations: 0,
      from: "2026-10-01T00:00:00Z", to: "2026-10-03T00:00:00Z" });
    delete rows[1].timestamp;
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await scan();
    expect(admitted).toBe(1);
    expect(store.status().connections[0]?.coverage).toMatchObject({ complete: false, unknownTimeBoundaries: 1, eligibleTurns: 0 });
    expect(JSON.stringify(manifests.at(-1))).not.toContain(file);
    expect(JSON.stringify(manifests.at(-1))).not.toContain("A durable answer");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

// Failure story: a missed calendar event starts a backfill on wake, a second
// process duplicates today's import, or an opt-out starts importing anyway.
test("scheduled launches require an explicit due time and run at most once per scheduled minute", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-daily-"));
  const file = join(root, "conversation.jsonl"), directory = join(root, "state");
  await writeFile(file, transcript);
  const store = await CollectorStore.open(directory);
  const now = new Date(2026, 9, 9, 0, 0, 15);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  let admissions = 0, heartbeats = 0;
  const transport = {
    publishCoverage: async () => {},
    heartbeat: async (current: CollectorConnection) => { heartbeats++; return { state: current.state, revision: current.revision }; },
    admit: async () => { admissions++; },
  };
  const scheduled = () => runCollector({ directory, signal: new AbortController().signal, trigger: "scheduled", transport });
  try {
    store.put(connection(file));
    await scheduled();
    expect(heartbeats).toBe(0);
    store.set("schedule:source", JSON.stringify({ frequency: "daily", time: "00:00" }));
    vi.setSystemTime(new Date(2026, 9, 9, 7, 30));
    await scheduled();
    expect(heartbeats).toBe(0);
    vi.setSystemTime(now);
    await scheduled();
    expect(admissions).toBe(1);
    expect(store.status()).toMatchObject({ running: false, desiredState: "stopped", connections: [{ schedule: { frequency: "daily", time: "00:00" }, queued: 0, run: { state: "completed" } }] });
    const probes = heartbeats;
    await scheduled();
    expect(heartbeats).toBe(probes);
    vi.setSystemTime(new Date(2026, 9, 10, 0, 0, 10));
    await scheduled();
    expect(heartbeats).toBeGreaterThan(probes);
    expect(admissions).toBe(1); // durable receipts prevent duplicate admission
    expect(store.setting("lastSuccess:source")).toBe(new Date().toISOString());
    expect(store.setting("owner")).toBe("");
    // A weekly source must not run on the daily timer's other weekdays.
    const weekly = { frequency: "weekly" as const, time: "00:00", day: 1 };
    store.set("schedule:source", JSON.stringify(weekly));
    const beforeWeekly = heartbeats;
    vi.setSystemTime(new Date(2026, 9, 11, 0, 0, 10)); // Sunday
    await scheduled();
    expect(heartbeats).toBe(beforeWeekly);
    expect(new Date(nextScheduledSync(weekly, new Date())).getDate()).toBe(12);
    vi.setSystemTime(new Date(2026, 9, 12, 0, 0, 10)); // Monday
    await scheduled();
    expect(heartbeats).toBeGreaterThan(beforeWeekly);
    const afterWeekly = heartbeats;
    await scheduled();
    vi.setSystemTime(new Date(2026, 9, 13, 0, 0, 10)); // Tuesday
    await scheduled();
    expect(heartbeats).toBe(afterWeekly);
    expect(admissions).toBe(1);
    expect(new Date(nextScheduledSync(weekly, new Date())).getDate()).toBe(19);
    expect(scheduledSyncDue({ frequency: "daily", time: "00:00" }, scheduledMinute(new Date()), new Date())).toBe(false);
    expect(new Date(nextScheduledSync({ frequency: "daily", time: "00:00" }, new Date())).getDate()).toBe(14);
    store.set("schedule:source", JSON.stringify({ frequency: "hourly" }));
    vi.setSystemTime(new Date(2026, 9, 13, 1, 0, 10));
    await scheduled();
    const firstHour = heartbeats;
    await scheduled();
    expect(heartbeats).toBe(firstHour);
    vi.setSystemTime(new Date(2026, 9, 13, 2, 0, 10));
    await scheduled();
    expect(heartbeats).toBeGreaterThan(firstHour);
    expect(admissions).toBe(1);
  } finally { vi.useRealTimers(); store.close(); await rm(root, { recursive: true, force: true }); }
});

// Failure story: a full/offline queue causes continuous re-reading of native
// files, loses retained work, or stores the same 20 MiB snapshot per batch.
test("upgrades retained snapshots, caps admission retries and exits before acquiring more history", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-backpressure-"));
  const directory = join(root, "state"), file = join(root, "unreadable.jsonl");
  await writeFile(file, "not valid source data\n");
  const store = await CollectorStore.open(directory);
  const current = connection(file);
  let attempts = 0;
  try {
    store.put(current);
    const entry: CollectorAdmission = { operationId: "one", connectionId: current.id, sessionKey: "session", contentHash: "snapshot", files: [{ path: "conversation.jsonl", text: transcript }], boundaryIds: ["first"] };
    // Persist the old queue shape to exercise the non-destructive migration.
    for (const id of ["one", "two"]) {
      const payload = JSON.stringify({ ...entry, operationId: id });
      store.database.prepare("INSERT INTO pending(id,connection_id,payload,bytes,created_at) VALUES(?,?,?,?,?)").run(id, current.id, payload, Buffer.byteLength(payload), 0);
    }
    await runCollector({ directory, signal: new AbortController().signal, trigger: "manual", transport: {
      publishCoverage: async () => {},
      heartbeat: async current => ({ revision: current.revision, state: current.state }),
      admit: async (_, retained) => { attempts++; expect(retained.files).toEqual(entry.files); throw new Error("Upload unavailable"); },
    } });
    expect(attempts).toBe(3);
    expect(store.queued(current.id)).toBe(2);
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM collector_snapshots").get()?.n).toBe(1);
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM source_scans").get()?.n).toBe(0);
    expect(store.status()).toMatchObject({ running: false, desiredState: "stopped", connections: [{ lastSuccessfulSyncAt: null, run: { state: "failed", error: "Upload unavailable" } }] });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

// Failure story: cancelling in Settings leaves a pending network request alive,
// or another CLI invocation steals ownership and starts concurrent imports.
test("fences concurrent jobs and propagates cancellation to in-flight admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-cancel-"));
  const file = join(root, "conversation.jsonl"), directory = join(root, "state");
  await writeFile(file, transcript);
  const store = await CollectorStore.open(directory);
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const transport = {
    publishCoverage: async () => {},
    heartbeat: async (current: CollectorConnection) => ({ revision: current.revision, state: current.state }),
    admit: async (_: CollectorConnection, __: CollectorAdmission, signal?: AbortSignal) => {
      markReady();
      await new Promise<void>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    },
  };
  try {
    store.put(connection(file));
    const job = runCollector({ directory, trigger: "manual", signal: new AbortController().signal, transport });
    await ready;
    await expect(runCollector({ directory, trigger: "manual", signal: new AbortController().signal, transport })).rejects.toThrow("already running");
    await expect(runCollector({ directory, trigger: "scheduled", signal: new AbortController().signal, transport })).resolves.toBeUndefined();
    store.set("desiredState", "stopped");
    await job;
    expect(store.status()).toMatchObject({ running: false, connections: [{ queued: 1, lastSuccessfulSyncAt: null, run: { state: "cancelled" } }] });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

// Failure story: an OS definition reintroduces boot launches, missed-run catch-up,
// wakeups or automatic failure restarts even though the worker is now bounded.
test("calendar jobs never launch on login, wake the host or restart a failed import", () => {
  const files = collectorServiceFiles({ name: "openpond-import-fixture", executable: "/path with spaces/node", gatePath: "/fixture/calendar-gate.cjs", args: ["cli.js", "import", "service", "run", "--scheduled"], environment: [], schedules: [{ frequency: "daily", time: "00:00" }, { frequency: "weekly", time: "01:00", day: 1 }, { frequency: "daily", time: "00:00" }] });
  expect(files.service).toContain("Type=oneshot");
  expect(files.service).toContain("Restart=no");
  expect(files.service).not.toContain("WantedBy=default.target");
  expect(files.timer.match(/OnCalendar=/gu)).toHaveLength(2);
  expect(files.timer).toContain("OnCalendar=mon *-*-* 01:00:00");
  expect(files.timer).toContain("Persistent=false");
  expect(files.timer).toContain("WakeSystem=false");
  expect(files.plist).toContain("<key>Weekday</key><integer>1</integer>");
  expect(files.plist).toContain("<key>RunAtLoad</key><false/>");
  expect(files.plist).toContain("<key>KeepAlive</key><false/>");
  const windows = files.windowsTask("fixture", "C:\\fixture\\run.ps1");
  expect(windows).toContain("<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Monday/></DaysOfWeek></ScheduleByWeek>");
  expect(windows).not.toContain("LogonTrigger");
  expect(windows).not.toContain("RestartOnFailure");
  expect(windows).toContain("<WakeToRun>false</WakeToRun>");
  expect(windows).toContain("<StartWhenAvailable>false</StartWhenAvailable>");
  expect(() => collectorServiceFiles({ name: "fixture", executable: "node", gatePath: "/fixture/gate.cjs", args: [], environment: [], schedules: [{ frequency: "daily", time: "25:00" }] })).toThrow("HH:MM");
});
