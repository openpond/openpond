import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { contentHash } from "@openpond/harness";
import {
  collectorDirectory,
  collectorMachineId,
  discoverSources,
  listSessions,
  CollectorStore,
  collectorStatus,
  controlCollector,
  configureCollector,
  installCollectorService,
  startCollectorService,
  uninstallCollectorService,
  runCollector,
  NATIVE_SOURCE_NAMES,
  type ExternalAgentSource,
  type CollectorConnection,
} from "@openpond/evals/native-conversations";
import { ConnectedSyncClient } from "openpond-sdk/connected-evidence";
import { optionString, promptConfirm, parseBooleanOption } from "./common";
import { authorizeImporter } from "../importer/device-auth";
import { collectorTransport, collectorClients } from "../importer/transport";
import { monitorImport } from "../importer/monitor";
import { retainedReconnect, assertReconnectSource, assertReconnectUnchanged } from "../importer/reconnect";
import { runImporterBranchCommand } from "../importer/branches";

export async function runImportCommand(
  options: Record<string, string | boolean>,
  rest: string[],
) {
  const [action = "connect", id] = rest,
    directory = resolve(
      optionString(options, "collectorDir") || collectorDirectory(),
    );
  const json = parseBooleanOption(options.json),
    print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (action === "branches" || action === "branch") {
    await runImporterBranchCommand(directory, action, id, options);
    return;
  }
  if (action === "service") {
    if (id === "status") {
      print(await collectorStatus(directory));
      return;
    }
    if (id === "stop") {
      print(await controlCollector(directory, "stop"));
      return;
    }
    if (id === "uninstall") {
      print(await uninstallCollectorService(directory));
      return;
    }
    if (id === "install") {
      print(
        await installCollectorService({
          directory,
          executable: process.execPath,
          args: [process.argv[1]!],
          environment: collectorEnvironment(),
        }),
      );
      return;
    }
    if (id === "start") {
      print(await startCollectorService(directory));
      return;
    }
    if (id === "run") {
      const controller = new AbortController(),
        stop = () => controller.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        await runCollector({
          directory,
          transport: collectorTransport,
          signal: controller.signal,
        });
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
      return;
    }
    throw new Error(
      "usage: openpond import service <install|start|stop|status|run|uninstall>",
    );
  }
  if (action === "status") {
    print(await collectorStatus(directory));
    return;
  }
  if (action === "sync") {
    print(await controlCollector(directory, "sync"));
    return;
  }
  if (["pause", "resume", "disconnect"].includes(action)) {
    const store = await CollectorStore.open(directory);
    let connection: CollectorConnection | undefined;
    try {
      connection = store.connections().find((item) => item.id === id);
    } finally {
      store.close();
    }
    if (!connection)
      throw new Error("Select a connection id from openpond import status.");
    const { sync } = await collectorClients(connection),
      remote = await sync.control({
        id: connection.id,
        expectedRevision: connection.revision,
        action: action as "pause" | "resume" | "disconnect",
      });
    await configureCollector(directory, {
      ...connection,
      revision: remote.revision,
      state: remote.state,
    });
    print(remote);
    return;
  }
  const reconnect = action === "reconnect" ? await retainedReconnect(directory, id) : null;
  if (reconnect) options = {
    ...options,
    source: reconnect.source.source,
    sourcePath: reconnect.source.root,
    project: reconnect.projectId,
    connection: reconnect.id,
    team: reconnect.teamId,
    apiBaseUrl: reconnect.apiBaseUrl,
    baseUrl: reconnect.accountBaseUrl!,
    once: !reconnect.keepSyncing,
  };
  const sourceName = optionString(options, "source") as ExternalAgentSource;
  if (sourceName && !(sourceName in NATIVE_SOURCE_NAMES))
    throw new Error("Choose a supported native source name.");
  const machineId = await collectorMachineId(directory),
    sources = await discoverSources({
      machineId,
      ...(sourceName && optionString(options, "sourcePath")
        ? {
            locations: {
              [sourceName]: resolve(optionString(options, "sourcePath")),
            },
          }
        : {}),
    });
  if (action === "discover") {
    print(sources);
    return;
  }
  if (action !== "connect" && action !== "reconnect")
    throw new Error(
      "usage: openpond import <connect|reconnect|discover|status|sync|pause|resume|disconnect|branches|branch|service>",
    );
  // An unavailable selected/default profile is still an authority choice.
  // Filtering it out could silently connect the sole remaining sibling.
  const matching = sources.filter((item) => item.source === sourceName);
  let source = matching.length === 1 ? matching[0] : undefined;
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !json;
  if (reconnect) assertReconnectSource(reconnect, source);
  if (!source && interactive) {
    const available =
      matching.length > 1 ? matching : sources.filter((item) => item.available);
    available.forEach((item, index) =>
      console.log(
        `${index + 1}. ${NATIVE_SOURCE_NAMES[item.source]}  ${item.root}${item.capabilities.history ? "" : ` (${item.reason})`}`,
      ),
    );
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      source =
        available[Number(await prompt.question("Choose a source: ")) - 1];
    } finally {
      prompt.close();
    }
  }
  if (!source?.capabilities.history)
    throw new Error(
      source?.reason ??
        (matching.length > 1
          ? "Multiple source instances found. Select the exact --source-path or use interactive setup."
          : "Select --source and optionally --source-path."),
    );
  let range = optionString(options, "range") || "week";
  if (!reconnect && interactive && !options.range) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      range =
        (await prompt.question("History: day, week, or all [week]: ")).trim() ||
        "week";
    } finally {
      prompt.close();
    }
  }
  if (!["day", "week", "all"].includes(range))
    throw new Error("--range must be day, week or all.");
  const since = reconnect ? reconnect.since :
    range === "all"
      ? null
      : new Date(
          Date.now() - (range === "day" ? 1 : 7) * 86400000,
        ).toISOString();
  const preview = await listSessions(source, {
    since: since ?? undefined,
    limit: 100,
  });
  if (!json)
    console.log(
      `Found ${preview.items.length}${preview.nextCursor ? "+" : ""} sessions in ${source.root}. History: ${reconnect ? since ? `since ${since}` : "all" : range}.`,
    );
  const keepSyncing = !parseBooleanOption(options.once),
    projectId = optionString(options, "project");
  if (
    !parseBooleanOption(options.yes) &&
    (!interactive ||
      !(await promptConfirm(
        `Sync this source to ${projectId || "your personal Imported conversations Project"} and ${keepSyncing ? "keep syncing" : "import once"}?`,
        true,
      )))
  )
    throw new Error("Connection was not approved. No history was uploaded.");
  const access = await authorizeImporter(source, options),
    sync = new ConnectedSyncClient(access),
    connectionId =
      optionString(options, "connection") ||
      `sync-${contentHash([access.baseUrl, access.teamId, source.instanceId, projectId || "default"]).slice(0, 40)}`;
  if (reconnect) await assertReconnectUnchanged(directory, reconnect);
  const prior = (await sync.list()).items.find(
    (item) => item.id === connectionId,
  );
  const retained = await sync.register({
    id: connectionId,
    source: source.source,
    machineId,
    sourceInstanceId: source.instanceId,
    sourceLabel: NATIVE_SOURCE_NAMES[source.source],
    sourceRoot: source.root,
    destination: projectId
      ? { kind: "existing", projectId }
      : { kind: "new", name: "Imported conversations" },
    since,
    keepSyncing,
    expectedRevision: prior?.revision ?? 0,
  });
  await configureCollector(directory, {
    id: retained.id,
    teamId: access.teamId,
    apiBaseUrl: access.baseUrl,
    account: access.account,
    accountBaseUrl: access.accountBaseUrl,
    source,
    projectId: retained.projectId,
    revision: retained.revision,
    since,
    keepSyncing,
    state: retained.state,
  });
  await installCollectorService({
    directory,
    executable: process.execPath,
    args: [process.argv[1]!],
    environment: collectorEnvironment(),
  });
  await startCollectorService(directory);
  print({ connection: retained, service: await collectorStatus(directory) });
  if (interactive && !parseBooleanOption(options.detach)) {
    await monitorImport({
      directory,
      connectionId,
      keepSyncing,
      async pause() {
        const store = await CollectorStore.open(directory);
        let current: CollectorConnection | undefined;
        try {
          current = store
            .connections()
            .find((item) => item.id === connectionId);
        } finally {
          store.close();
        }
        if (!current) throw new Error("The connection is unavailable.");
        const { sync: client } = await collectorClients(current);
        const remote = await client.control({
          id: current.id,
          expectedRevision: current.revision,
          action: "pause",
        });
        await configureCollector(directory, {
          ...current,
          revision: remote.revision,
          state: remote.state,
        });
      },
    });
  }
}

function collectorEnvironment() {
  return {
    ...(process.env.OPENPOND_HOME
      ? { OPENPOND_HOME: process.env.OPENPOND_HOME }
      : {}),
    ...(process.env.ELECTRON_RUN_AS_NODE === "1"
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : {}),
  };
}
