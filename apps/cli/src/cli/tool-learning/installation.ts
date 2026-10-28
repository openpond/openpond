import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteFile, readOptionalFile, withFileLock } from "@openpond/persistence";
import { contentHash } from "@openpond/harness";
import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import { probeToolLearningMcp } from "@openpond/local-server/tool-learning";
import { IS_COMPILED_CLI } from "../build-mode";
import {
  loadToolLearningCredential,
  toolLearningHome,
  toolLearningProducer,
  type ToolLearningOptions,
} from "./credentials";
const exec = promisify(execFile);
const Events = ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;
const Receipt = z
  .object({
    schemaVersion: z.literal("openpond.toolLearningClientInstall.v1"),
    installationId: z.string(),
    workspaceRoot: z.string(),
    clientVersion: z.string(),
    adapterRelease: z.object({ id: z.string(), contentHash: z.string() }),
    launcher: z.array(z.string()).min(1),
    command: z.string(),
    settingsPath: z.string(),
    installedAt: z.iso.datetime(),
    configurationHash: z.string(),
    ownedCommands: z.array(z.string()).min(1).max(32),
    mcpName: z.string(),
    ownedMcpHashes: z.array(z.string()).min(1).max(32),
  })
  .strict();
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const receiptPath = (home: string, id: string) =>
  join(home, "tool-learning", `client-${contentHash(id)}.json`);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Claude settings must be a JSON object.");
  return value as Record<string, unknown>;
}
function hookGroups(settings: Record<string, unknown>) {
  return settings.hooks === undefined ? {} : object(settings.hooks);
}
function groups(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Claude hooks must be arrays.");
  return value;
}
function owns(value: unknown, command: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hooks = (value as Record<string, unknown>).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (h) => !!h && typeof h === "object" && (h as Record<string, unknown>).command === command,
    )
  );
}
function withoutOwned(values: unknown[], commands: string[]) {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [value];
    const group = value as Record<string, unknown>;
    if (!Array.isArray(group.hooks)) return [value];
    const retained = group.hooks.filter(
      (h) =>
        !h ||
        typeof h !== "object" ||
        !commands.includes(String((h as Record<string, unknown>).command)),
    );
    return retained.length ? [{ ...group, hooks: retained }] : [];
  });
}
async function installedReceipt(home: string, id: string) {
  const raw = await readOptionalFile(receiptPath(home, id));
  return raw ? Receipt.parse(JSON.parse(raw)) : null;
}

/** Merge only the exact owned entries. Unknown settings remain byte-for-byte
 * values; a user's edits are never restored from a stale whole-file backup. */
export async function installClaudeToolLearning(options: ToolLearningOptions, id: string) {
  if (process.platform === "win32")
    throw new Error("Claude tool-learning shell hooks are not qualified on Windows yet.");
  const home = toolLearningHome(options),
    { value: record } = await loadToolLearningCredential(home, id);
  if (record.prepared.registration.client !== "claude_code")
    throw new Error("Select a Claude Code installation.");
  if (!record.locallyEnabled || record.installation?.state !== "enabled")
    throw new Error("Enable this registered installation before installing its hooks.");
  const remote = await toolLearningProducer(record).installation(id);
  if (
    remote.state !== "enabled" ||
    remote.collectionPolicyHash !== record.installation.collectionPolicyHash
  )
    throw new Error(
      "The installation or collection policy changed. Reconfigure it before installing hooks.",
    );
  const version = (
    await exec("claude", ["--version"], { timeout: 10000, maxBuffer: 65536 })
  ).stdout.trim();
  if (version.split(" ")[0] !== record.prepared.registration.clientVersion)
    throw new Error(
      "Claude version changed. Register and qualify the installed version before enabling hooks.",
    );
  const root = await realpath(record.workspaceRoot),
    settingsPath = join(root, ".claude", "settings.local.json");
  const sourceEntry = !IS_COMPILED_CLI && /\.[cm]?ts$/u.test(process.argv[1] ?? "");
  const launcher = [
    ...(sourceEntry
      ? [
          "/usr/bin/env",
          `TSX_TSCONFIG_PATH=${resolve(dirname(process.argv[1]!), "../../tsconfig.json")}`,
        ]
      : []),
    process.execPath,
    ...(IS_COMPILED_CLI ? [] : [...process.execArgv, process.argv[1]!]),
    "tool-learning",
    "hook",
    id,
    "--home",
    home,
  ];
  if (launcher.some((v) => !v || v.includes("\n") || v.includes("\r")))
    throw new Error("Invalid hook launcher.");
  const command = launcher.map(quote).join(" "),
    previous = await installedReceipt(home, id);
  const mcpName = `openpond-tool-learning-${contentHash(id).slice(0, 12)}`;
  const mcpConfiguration = {
    type: "stdio",
    command: launcher[0],
    args: launcher
      .slice(1)
      .map((arg, index) => (index === launcher.indexOf("hook") - 1 ? "mcp" : arg)),
  };
  const receipt = Receipt.parse({
    schemaVersion: "openpond.toolLearningClientInstall.v1",
    installationId: id,
    workspaceRoot: root,
    clientVersion: record.prepared.registration.clientVersion,
    adapterRelease: record.prepared.registration.adapterRelease,
    launcher,
    command,
    settingsPath,
    installedAt: new Date().toISOString(),
    configurationHash: contentHash({ command, events: Events }),
    ownedCommands: [...new Set([...(previous?.ownedCommands ?? []), command])],
    mcpName,
    ownedMcpHashes: [
      ...new Set([...(previous?.ownedMcpHashes ?? []), contentHash(mcpConfiguration)]),
    ],
  });
  // The prepared ownership receipt precedes settings mutation, so a crash can
  // reconcile the exact owned entries on reinstall or uninstall.
  await atomicWriteFile(receiptPath(home, id), JSON.stringify(receipt, null, 2) + "\n");
  await mkdir(join(root, ".claude"), { recursive: true, mode: 0o700 });
  await withFileLock(
    join(home, "tool-learning", `settings-${contentHash(settingsPath)}`),
    async () => {
      const raw = await readOptionalFile(settingsPath);
      if (raw && Buffer.byteLength(raw) > 1048576) throw new Error("Claude settings exceed 1 MiB.");
      const settings = raw ? object(JSON.parse(raw)) : {},
        hooks = hookGroups(settings);
      for (const event of Events) {
        const retained = withoutOwned(groups(hooks[event]), receipt.ownedCommands);
        hooks[event] = [
          ...retained,
          {
            ...(event === "SessionStart" ? { matcher: "startup|resume|compact" } : {}),
            hooks: [{ type: "command", command, timeout: 8 }],
          },
        ];
      }
      settings.hooks = hooks;
      await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
        privateParent: false,
      });
    },
  );
  const mcpPath = join(root, ".mcp.json");
  await withFileLock(join(home, "tool-learning", `mcp-${contentHash(mcpPath)}`), async () => {
    const raw = await readOptionalFile(mcpPath);
    if (raw && Buffer.byteLength(raw) > 1048576)
      throw new Error("MCP configuration exceeds 1 MiB.");
    const config = raw ? object(JSON.parse(raw)) : {};
    const servers = config.mcpServers === undefined ? {} : object(config.mcpServers);
    if (
      servers[mcpName] !== undefined &&
      !receipt.ownedMcpHashes.includes(contentHash(servers[mcpName]))
    )
      throw new Error(
        "The MCP name contains user changes. Preserve or rename that entry before reinstalling.",
      );
    servers[mcpName] = mcpConfiguration;
    config.mcpServers = servers;
    await atomicWriteFile(mcpPath, JSON.stringify(config, null, 2) + "\n", {
      privateParent: false,
    });
  });
  await atomicWriteFile(
    receiptPath(home, id),
    JSON.stringify(
      { ...receipt, ownedCommands: [command], ownedMcpHashes: [contentHash(mcpConfiguration)] },
      null,
      2,
    ) + "\n",
  );
  return {
    installationId: id,
    configuration: "installed",
    clientRestartRequired: true,
    clientTrust: "pending_actual_session",
    settingsPath,
    credentials: "encrypted_openpond_home",
    learningEnrollment: false,
  };
}
export async function uninstallClaudeToolLearning(options: ToolLearningOptions, id: string) {
  const home = toolLearningHome(options),
    receipt = await installedReceipt(home, id);
  if (!receipt) return { installationId: id, configuration: "already_absent" };
  await withFileLock(
    join(home, "tool-learning", `settings-${contentHash(receipt.settingsPath)}`),
    async () => {
      const raw = await readOptionalFile(receipt.settingsPath);
      if (!raw) return;
      if (Buffer.byteLength(raw) > 1048576) throw new Error("Claude settings exceed 1 MiB.");
      const settings = object(JSON.parse(raw)),
        hooks = hookGroups(settings);
      for (const event of Events) {
        const retained = withoutOwned(groups(hooks[event]), receipt.ownedCommands);
        if (retained.length) hooks[event] = retained;
        else delete hooks[event];
      }
      settings.hooks = hooks;
      await atomicWriteFile(receipt.settingsPath, JSON.stringify(settings, null, 2) + "\n", {
        privateParent: false,
      });
    },
  );
  const mcpPath = join(receipt.workspaceRoot, ".mcp.json");
  await withFileLock(join(home, "tool-learning", `mcp-${contentHash(mcpPath)}`), async () => {
    const raw = await readOptionalFile(mcpPath);
    if (!raw) return;
    if (Buffer.byteLength(raw) > 1048576) throw new Error("MCP configuration exceeds 1 MiB.");
    const config = object(JSON.parse(raw)),
      servers = config.mcpServers === undefined ? {} : object(config.mcpServers);
    if (
      servers[receipt.mcpName] !== undefined &&
      receipt.ownedMcpHashes.includes(contentHash(servers[receipt.mcpName]))
    )
      delete servers[receipt.mcpName];
    config.mcpServers = servers;
    await atomicWriteFile(mcpPath, JSON.stringify(config, null, 2) + "\n", {
      privateParent: false,
    });
  });
  return {
    installationId: id,
    configuration: "removed",
    clientRestartRequired: true,
    retainedData:
      "Use purge to delete hosted raw events. Reviewed Datasets have separate retention.",
  };
}
export async function doctorToolLearning(options: ToolLearningOptions, id: string) {
  const home = toolLearningHome(options),
    { value: record } = await loadToolLearningCredential(home, id),
    receipt = await installedReceipt(home, id);
  const remote = await toolLearningProducer(record).installation(id);
  const store = new ToolLearningLocalStore(home);
  try {
    const issues: string[] = [];
    let configured = record.prepared.registration.client === "openpond";
    if (receipt) {
      await access(receipt.launcher[0]!);
      const raw = await readOptionalFile(receipt.settingsPath);
      if (raw && Buffer.byteLength(raw) <= 1048576) {
        const hooks = hookGroups(object(JSON.parse(raw)));
        configured = Events.every((event) =>
          groups(hooks[event]).some((g) => owns(g, receipt.command)),
        );
      }
    }
    if (receipt) {
      const mcpRaw = await readOptionalFile(join(receipt.workspaceRoot, ".mcp.json"));
      const config =
        mcpRaw && Buffer.byteLength(mcpRaw) <= 1048576 ? object(JSON.parse(mcpRaw)) : {};
      const servers = config.mcpServers === undefined ? {} : object(config.mcpServers);
      if (
        servers[receipt.mcpName] === undefined ||
        !receipt.ownedMcpHashes.includes(contentHash(servers[receipt.mcpName]))
      )
        configured = false;
    }
    let mcp: { reachable: boolean; server?: unknown; tools?: string[]; reason?: string } | null =
      null;
    if (configured && receipt && record.locallyEnabled && remote.state === "enabled") {
      const index = receipt.launcher.indexOf("hook");
      const args = receipt.launcher
        .slice(1)
        .map((arg, offset) => (offset === index - 1 ? "mcp" : arg));
      try {
        mcp = await probeToolLearningMcp(receipt.launcher[0]!, args);
      } catch {
        mcp = { reachable: false, reason: "MCP handshake or tool discovery failed." };
        issues.push(
          "Restart the client and run doctor again; the consultation process did not answer discovery.",
        );
      }
    }
    if (!configured) issues.push("Run tool-learning install for this registered installation.");
    const observed = store.clientObservations(id);
    if (
      !observed.some((item) =>
        record.prepared.registration.client === "openpond"
          ? item.event === "turn_context"
          : ["start", "resume", "compact"].includes(String(item.event)),
      )
    )
      issues.push(
        "Start or restart the client and confirm workspace trust; no real lifecycle hook has been observed.",
      );
    if (remote.state !== "enabled" || !record.locallyEnabled)
      issues.push("Collection is disabled or revoked.");
    const status = store.status(id);
    if (status.pendingEvents)
      issues.push("Pending evidence remains queued; run tool-learning flush.");
    if (status.droppedEvents)
      issues.push("Some events were excluded by privacy or capacity limits.");
    return {
      installationId: id,
      configured,
      remoteState: remote.state,
      locallyEnabled: record.locallyEnabled,
      observed,
      mcp,
      local: status,
      issues,
      learningEnrollment: false,
    };
  } finally {
    store.close();
  }
}
