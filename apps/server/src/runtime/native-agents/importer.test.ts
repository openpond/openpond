import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
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
    "OPENPOND_COLLECTOR_CLI",
    "OPENPOND_COLLECTOR_EXECUTABLE",
  ] as const;
  const prior = values.map((key) => process.env[key]);
  try {
    process.env.OPENPOND_HOME = home;
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
      keepSyncing: false,
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
    expect(stdout).toContain("--range all --detach --once");
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
