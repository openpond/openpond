import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { CollectorStore, nativeUploadInventory, nativeSessionSelectionKey, type CollectorConnection } from "@openpond/evals/native-conversations";
import { runImportCommand } from "../src/cli/import";

const fixture = vi.hoisted(() => ({ schedules: vi.fn(), admissions: 0, registration: null as Record<string, unknown> | null }));
vi.mock("@openpond/evals/native-conversations", async original => ({ ...await original<object>(), setCollectorSchedule: fixture.schedules }));
vi.mock("../src/importer/device-auth", () => ({ authorizeImporter: async () => ({ apiKey: "fixture", baseUrl: "https://api.example.test", accountBaseUrl: "https://example.test", account: "fixture", teamId: "team" }) }));
vi.mock("openpond-sdk/connected-evidence", () => ({ ConnectedSyncClient: class {
  async list() { return { items: [] }; }
  async register(input: Record<string, unknown>) { fixture.registration = input; return { ...input, projectId: "project", revision: 1, state: "active", requestedSyncRevision: 0, completedSyncRevision: 0 }; }
} }));
vi.mock("../src/importer/transport", () => ({ collectorTransport: {
  publishCoverage: async () => {},
  heartbeat: async (current: CollectorConnection) => ({ revision: current.revision, state: current.state }),
  admit: async () => { fixture.admissions++; },
}, collectorClients: async () => ({ sync: { register: async (input: Record<string, unknown>) => {
  fixture.registration = input;
  return { ...input, projectId: "project", revision: Number(input.expectedRevision) + 1, state: "active", requestedSyncRevision: 0, completedSyncRevision: 0 };
} } }) }));

// Failure story: connecting uploads history before selection, or an explicit
// initial upload silently enables recurrence or returns with hidden work.
test("CLI connects without uploading and requires explicit upload and recurrence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cli-import-once-"));
  const sourcePath = join(directory, "source.jsonl"), collectorDir = join(directory, "collector");
  const now = new Date().toISOString();
  await writeFile(sourcePath, [
    { type: "session", version: 3, id: "fixture", timestamp: now },
    { type: "message", id: "u", timestamp: now, parentId: null, message: { role: "user", content: "Request" } },
    { type: "message", id: "a", timestamp: now, parentId: "u", message: { role: "assistant", content: "Answer", stopReason: "stop" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const options = { source: "pi", sourcePath, collectorDir, yes: true, json: true };
    await runImportCommand(options, []);
    expect(fixture.schedules).not.toHaveBeenCalled();
    expect(fixture.admissions).toBe(0);
    const idle = await CollectorStore.open(collectorDir);
    try {
      expect(idle.connections()[0]!.selectedSessionKeys).toEqual([]);
      expect(idle.status()).toMatchObject({ running: false, connections: [{ run: null, selectedConversations: 0 }] });
    } finally { idle.close(); }
    await expect(runImportCommand({ collectorDir, json: true }, ["sync"])).rejects.toThrow("Choose conversations first");
    await runImportCommand({ ...options, upload: true }, []);
    expect(fixture.admissions).toBe(1);
    const since = Date.parse(String(fixture.registration?.since));
    expect(Date.now() - since).toBeGreaterThanOrEqual(7 * 86400000);
    expect(Date.now() - since).toBeLessThan(7 * 86400000 + 10000);
    const store = await CollectorStore.open(collectorDir);
    let id: string;
    try {
      id = store.connections()[0]!.id;
      expect(store.status()).toMatchObject({ running: false, desiredState: "stopped", connections: [{ schedule: null, run: { state: "completed" } }] });
      expect(store.connections()[0]!.credentialHome).toBeTruthy();
    } finally { store.close(); }
    for (const invalid of [{ daily: true }, { weekly: true }, { at: "01:00" },
      { continual: true, daily: true, weekly: true }, { continual: true, on: "mon" },
      { continual: true, weekly: true, on: "noday" }, { continual: true, at: "25:00" },
      { continual: true, off: true }, { hourly: true }, { everyMinute: true }, { cron: "*/15 * * * *" },
      { continual: true, hourly: true, at: "01:00" }, { continual: true, everyMinute: true, weekly: true },
      { continual: true, cron: "* * * * * *" }, { continual: true, cron: "61 * * * *" },
      { continual: true, cron: "0 0 L * *" }, { continual: true, cron: "0 0 * * mon", daily: true }]) {
      await expect(runImportCommand({ ...options, ...invalid }, ["schedule", id])).rejects.toThrow();
    }
    expect(fixture.schedules).not.toHaveBeenCalled();
    await runImportCommand({ ...options, continual: true }, ["schedule", id]);
    expect(fixture.schedules).toHaveBeenCalledOnce();
    expect(fixture.schedules.mock.calls[0]!.slice(1)).toEqual([id, { frequency: "daily", time: "00:00" }]);
    await runImportCommand({ ...options, continual: true, weekly: true }, ["schedule", id]);
    expect(fixture.schedules.mock.calls.at(-1)!.slice(1)).toEqual([id, { frequency: "weekly", time: "00:00", day: 1 }]);
    await runImportCommand({ ...options, continual: true, weekly: true, on: "fri", at: "01:00" }, ["schedule", id]);
    expect(fixture.schedules.mock.calls.at(-1)!.slice(1)).toEqual([id, { frequency: "weekly", time: "01:00", day: 5 }]);
    for (const [flags, schedule] of [
      [{ hourly: true }, { frequency: "hourly" }],
      [{ cron: "15 9-17 * * mon-fri" }, { frequency: "cron", expression: "15 9-17 * * 1-5" }],
    ] as const) {
      await runImportCommand({ ...options, continual: true, ...flags }, ["schedule", id]);
      expect(fixture.schedules.mock.calls.at(-1)!.slice(1)).toEqual([id, schedule]);
    }
    await runImportCommand({ ...options, off: true }, ["schedule", id]);
    expect(fixture.schedules.mock.calls.at(-1)!.slice(1)).toEqual([id, null]);
    expect(fixture.admissions).toBe(1); // scheduling does not launch another job
    const retained = await CollectorStore.open(collectorDir);
    const selectionFile = join(directory, "selection.json");
    try {
      const connection = retained.connections()[0]!;
      const item = (await nativeUploadInventory(connection.source))[0]!;
      const sessionKeys = [nativeSessionSelectionKey(item)];
      await writeFile(selectionFile, JSON.stringify({ sourceInstanceId: connection.source.instanceId, sessionKeys }));
      await runImportCommand({ collectorDir, selectionFile, json: true }, ["sync", id]);
      expect(retained.connections()[0]).toMatchObject({ since: null, selectedSessionKeys: sessionKeys });
      expect(fixture.registration).toMatchObject({ id, since: null });
      // Widening the old time window reacquires it but preserves server identity.
      expect(retained.status().connections[0]!.admitted).toBe(1);
      const before = fixture.admissions;
      await runImportCommand({ collectorDir, selectionFile, json: true }, ["sync", id]);
      expect(fixture.admissions).toBe(before);
      await writeFile(selectionFile, JSON.stringify({ sourceInstanceId: "wrong-source", sessionKeys }));
      await expect(runImportCommand({ collectorDir, selectionFile, json: true }, ["sync", id])).rejects.toThrow("another source");
    } finally { retained.close(); }
  } finally { log.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
