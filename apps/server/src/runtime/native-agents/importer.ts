import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  collectorDirectory,
  collectorMachineId,
  collectorStatus,
  controlCollector,
  discoverSources,
  installCollectorService,
  startCollectorService,
  type NativeSource,
} from "@openpond/evals/native-conversations";
import { readProvidersFile } from "../../openpond/provider-settings.js";
import { nativeTerminalCommand } from "./terminal-command.js";

const Line = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n\0]/u.test(value), "Use a single-line value.");
const Setup = z
  .object({
    sourceInstanceId: Line,
    teamId: Line,
    projectId: Line,
    accountBaseUrl: z.string().url(),
    apiBaseUrl: z.string().url(),
    range: z.enum(["day", "week", "all"]),
    keepSyncing: z.boolean(),
  })
  .strict();
const Request = z
  .object({
    command: z.enum([
      "inventory",
      "status",
      "start",
      "stop",
      "sync",
      "install",
      "connect",
      "reconnect",
      "pause",
      "resume",
      "disconnect",
    ]),
    connectionId: Line.optional(),
    setup: Setup.optional(),
  })
  .strict();

async function discover(storeDir: string, directory: string) {
  const settings = await readProvidersFile(join(storeDir, "providers.json"));
  const locations: Partial<Record<NativeSource["source"], string>> = {};
  for (const [source, provider] of [
    ["codex", "codex"],
    ["claude_code", "claude-code"],
    ["opencode", "opencode"],
    ["grok_build", "grok-build"],
  ] as const) {
    const home = settings.providers[provider]?.sourceHome;
    if (home)
      locations[source] = source === "opencode" ? join(home, "opencode") : home;
  }
  return discoverSources({
    machineId: await collectorMachineId(directory),
    locations,
  });
}

/** Shared CLI state and quoted setup commands; reading inventory never starts collection. */
export async function handleNativeImporter(payload: unknown, storeDir: string) {
  const { command, connectionId, setup } = Request.parse(payload);
  const directory = collectorDirectory();
  if (command === "inventory") {
    const [sources, collector] = await Promise.all([
      discover(storeDir, directory),
      collectorStatus(directory),
    ]);
    const cli = process.env.OPENPOND_COLLECTOR_CLI;
    const executable = process.env.OPENPOND_COLLECTOR_EXECUTABLE;
    const statusCommand = nativeTerminalCommand(
      cli && executable ? executable : "openpond",
      [
        ...(cli && executable ? [cli] : []),
        "import",
        "status",
        "--collector-dir",
        directory,
      ],
      cli && executable ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    );
    return { sources, collector, directory, statusCommand };
  }
  if (command === "status") return collectorStatus(directory);
  if (
    [
      "install",
      "connect",
      "reconnect",
      "pause",
      "resume",
      "disconnect",
    ].includes(command)
  ) {
    const cli = process.env.OPENPOND_COLLECTOR_CLI;
    const executable = process.env.OPENPOND_COLLECTOR_EXECUTABLE;
    if (!cli || !executable)
      throw new Error(
        "The bundled Importer is unavailable. Install the OpenPond CLI to connect a source.",
      );
    await Promise.all([access(cli), access(executable)]);
    const environment = {
      ELECTRON_RUN_AS_NODE: "1",
      ...(process.env.OPENPOND_HOME
        ? { OPENPOND_HOME: process.env.OPENPOND_HOME }
        : {}),
    };
    if (command === "install")
      return installCollectorService({
        directory,
        executable,
        args: [cli],
        environment,
      });
    if (command !== "connect") {
      const retained = (await collectorStatus(directory)).connections.find(
        (item) => item.id === connectionId,
      );
      if (!retained) throw new Error("Select a retained Importer connection.");
      if (command !== "reconnect" && retained.state === "disconnected")
        throw new Error("Reconnect this source before changing its state.");
      return {
        command: nativeTerminalCommand(
          executable,
          [
            cli,
            "import",
            command,
            retained.id,
            "--collector-dir",
            directory,
            ...(command === "reconnect" ? ["--detach"] : []),
          ],
          environment,
        ),
      };
    }
    const args = [cli, "import", "connect", "--collector-dir", directory];
    if (setup) {
      const source = (await discover(storeDir, directory)).find(
        (item) => item.instanceId === setup.sourceInstanceId,
      );
      if (!source?.available || !source.capabilities.history)
        throw new Error(
          "The selected source is unavailable. Refresh and select its exact installation.",
        );
      args.push(
        "--source",
        source.source,
        "--source-path",
        source.root,
        "--team",
        setup.teamId,
        "--project",
        setup.projectId,
        "--base-url",
        setup.accountBaseUrl,
        "--api-base-url",
        setup.apiBaseUrl,
        "--range",
        setup.range,
        "--detach",
      );
      if (!setup.keepSyncing) args.push("--once");
    }
    return { command: nativeTerminalCommand(executable, args, environment) };
  }
  if (command === "start") return startCollectorService(directory);
  return controlCollector(directory, command as "stop" | "sync");
}
