import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  CollectorStore,
  type NativeSource,
} from "@openpond/evals/native-conversations";
import { handleNativeImporter } from "./importer.js";

const fixture = vi.hoisted(() => ({ sources: [] as NativeSource[] }));
vi.mock("@openpond/evals/native-conversations", async (original) => ({
  ...(await original<object>()),
  discoverSources: async () => fixture.sources,
}));

// Failure story: a card silently imports another installation/project or turns a
// source path into shell code. Exercise the real retained store and CLI boundary.
test("preserves exact source and destination, quotes setup, and reads safe retained state without starting collection", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-card-import-"));
  const values = [
    "OPENPOND_HOME",
    "OPENPOND_COLLECTOR_DIR",
    "OPENPOND_COLLECTOR_CLI",
    "OPENPOND_COLLECTOR_EXECUTABLE",
  ] as const;
  const prior = values.map((key) => process.env[key]);
  try {
    process.env.OPENPOND_HOME = home;
    process.env.OPENPOND_COLLECTOR_DIR = join(home, "conversation-importer");
    process.env.OPENPOND_COLLECTOR_CLI = join(home, "cli fixture.mjs");
    process.env.OPENPOND_COLLECTOR_EXECUTABLE = "/bin/echo";
    await writeFile(process.env.OPENPOND_COLLECTOR_CLI, "");
    const marker = join(home, "must-not-exist");
    const source: NativeSource = {
      source: "claude_code",
      machineId: "machine",
      instanceId: "chosen",
      root: `${home}/Claude '$(touch ${marker})`,
      acquisition: "files",
      available: true,
      capabilities: { history: true, live: false, nativeResume: false },
    };
    fixture.sources = [
      source,
      { ...source, instanceId: "sibling", root: join(home, "another-account") },
    ];
    const store = await CollectorStore.open(
      join(home, "conversation-importer"),
    );
    try {
      store.put({
        id: "retained",
        teamId: "original-team",
        apiBaseUrl: "https://api.example.test",
        accountBaseUrl: "https://example.test",
        account: "encrypted-key-alias",
        source,
        projectId: "original-project",
        revision: 4,
        since: null,
        keepSyncing: true,
        state: "paused",
      });
    } finally {
      store.close();
    }
    const inventory = (await handleNativeImporter(
      { command: "inventory" },
      home,
    )) as {
      collector: ReturnType<CollectorStore["status"]>;
      sources: NativeSource[];
    };
    expect(inventory.collector.running).toBe(false);
    expect(inventory.collector.connections[0]).toMatchObject({
      state: "paused",
      projectId: "original-project",
      teamId: "original-team",
      sourceInstanceId: "chosen",
      sourceRoot: source.root,
    });
    expect(JSON.stringify(inventory)).not.toContain("encrypted-key-alias");
    const setup = {
      sourceInstanceId: "chosen",
      teamId: "selected-team",
      projectId: "selected-project",
      accountBaseUrl: "https://example.test",
      apiBaseUrl: "https://api.example.test",
      range: "all",
    };
    const result = (await handleNativeImporter(
      { command: "connect", setup },
      home,
    )) as { command: string };
    const { stdout } = await promisify(execFile)("bash", [
      "-c",
      result.command,
    ]);
    expect(stdout).toContain(
      `--source claude_code --source-path ${source.root}`,
    );
    expect(stdout).toContain("--team selected-team --project selected-project");
    expect(stdout).toContain("--range all");
    expect(stdout).not.toContain("--continual");
    expect(stdout).not.toContain("--detach");
    await expect(access(marker)).rejects.toThrow();
    await expect(
      handleNativeImporter(
        {
          command: "connect",
          setup: { ...setup, sourceInstanceId: "removed" },
        },
        home,
      ),
    ).rejects.toThrow("selected source is unavailable");
    await expect(
      handleNativeImporter(
        { command: "connect", setup: { ...setup, projectId: "" } },
        home,
      ),
    ).rejects.toThrow();
    const reconnect = (await handleNativeImporter(
      { command: "reconnect", connectionId: "retained" },
      home,
    )) as { command: string };
    expect(reconnect.command).toContain("'reconnect' 'retained'");
    expect(reconnect.command).not.toContain("selected-project");
    const unchanged = await CollectorStore.open(
      join(home, "conversation-importer"),
    );
    try {
      expect(unchanged.connections()[0]).toMatchObject({
        teamId: "original-team",
        projectId: "original-project",
        revision: 4,
        state: "paused",
      });
    } finally {
      unchanged.close();
    }
  } finally {
    values.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
    await rm(home, { recursive: true, force: true });
  }
});

// Failure story: searching uploads data, selection drops records beyond page 1,
// or the terminal command uses a changed source/selection instead of consent.
test("searches local Claude conversations and hands a validated frozen selection to the CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-upload-selection-"));
  const keys = ["OPENPOND_HOME", "OPENPOND_COLLECTOR_DIR", "OPENPOND_COLLECTOR_CLI", "OPENPOND_COLLECTOR_EXECUTABLE"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.OPENPOND_HOME = home;
    process.env.OPENPOND_COLLECTOR_DIR = join(home, "collector");
    process.env.OPENPOND_COLLECTOR_CLI = join(home, "cli.mjs");
    process.env.OPENPOND_COLLECTOR_EXECUTABLE = "/bin/echo";
    await writeFile(process.env.OPENPOND_COLLECTOR_CLI, "");
    const root = join(home, "claude"), folder = join(root, "projects", "review");
    await mkdir(folder, { recursive: true });
    for (let index = 0; index < 51; index++) {
      const sessionId = `conversation-${index}`;
      await writeFile(join(folder, `${sessionId}.jsonl`), [
        { uuid: "u", parentUuid: null, sessionId, type: "user", cwd: index === 0 ? "/work/Invoices" : "/work/Review", timestamp: "2026-10-01T00:00:00Z", message: { content: `Review request ${index}` } },
        { uuid: "a", parentUuid: "u", sessionId, type: "assistant", timestamp: "2026-10-01T00:00:01Z", message: { content: "Reviewed", stop_reason: "end_turn" } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
    }
    const source: NativeSource = { source: "claude_code", machineId: "machine", instanceId: "chosen", root,
      acquisition: "files", available: true, capabilities: { history: true, live: false, nativeResume: false } };
    fixture.sources = [source];
    const store = await CollectorStore.open(process.env.OPENPOND_COLLECTOR_DIR);
    try { store.put({ id: "connection", source, teamId: "team", projectId: "project", apiBaseUrl: "https://api.example.test", revision: 1, since: null, keepSyncing: false, selectedSessionKeys: [], state: "active" }); }
    finally { store.close(); }
    type Page = { total: number; items: Array<{ key: string; nativeSessionId: string }>; nextOffset: number | null };
    const list = (query = "", offset = 0) => handleNativeImporter({ command: "conversations", connectionId: "connection", query, range: "all", offset }, home) as Promise<Page>;
    const first = await list();
    expect(first).toMatchObject({ total: 51, nextOffset: 50 });
    expect(first.items).toHaveLength(50);
    expect((await list("", 50)).items).toHaveLength(1);
    expect((await list("invoices")).total).toBe(1);
    const selected = await list("conversation-50");
    expect(selected.items).toHaveLength(1);
    const sessionKeys = [selected.items[0]!.key];
    const result = await handleNativeImporter({ command: "upload", connectionId: "connection", sessionKeys }, home) as { command: string };
    const { stdout } = await promisify(execFile)("bash", ["-c", result.command]);
    const selectionFile = stdout.split("--selection-file ")[1]!.split(" --collector-dir")[0]!;
    expect(JSON.parse(await readFile(selectionFile, "utf8"))).toEqual({ sourceInstanceId: "chosen", sessionKeys });
    expect(stdout).toContain("import sync connection");
    await expect(handleNativeImporter({ command: "upload", connectionId: "connection", sessionKeys: ["f".repeat(64)] }, home)).rejects.toThrow("no longer available");
    const unchanged = await CollectorStore.open(process.env.OPENPOND_COLLECTOR_DIR);
    try {
      expect(unchanged.status()).toMatchObject({ running: false, connections: [{ admitted: 0, queued: 0, selectedConversations: 0 }] });
    } finally { unchanged.close(); }
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(home, { recursive: true, force: true });
  }
});
