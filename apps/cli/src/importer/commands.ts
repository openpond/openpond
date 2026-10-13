import { CollectorStore, collectorStatus, controlCollector, setCollectorSchedule, uninstallCollectorService, installCollectorService, NATIVE_SOURCE_NAMES, nativeUploadConversationPage, nativeUploadInventory, type CollectorServiceSetup } from "@openpond/evals/native-conversations";
import { parseBooleanOption, optionString } from "../cli/common";
import { runImportJob } from "./run";
import { importSchedule } from "./schedule";
import { applyUploadSelection } from "./selection";
import { collectorClients } from "./transport";

export function collectorSetup(directory: string): CollectorServiceSetup {
  return { directory, executable: process.execPath, args: [...process.execArgv, process.argv[1]!],
    environment: { ...(process.env.OPENPOND_HOME ? { OPENPOND_HOME: process.env.OPENPOND_HOME } : {}),
      ...(process.env.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } };
}

export async function runImporterControl(directory: string, action: string, id: string | undefined, options: Record<string, string | boolean>) {
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const json = parseBooleanOption(options.json);
  if (action === "status") { print(await collectorStatus(directory)); return true; }
  if (action === "conversations") {
    if (!id) throw new Error("Use openpond import conversations <connection-id> [--query <text>] [--range day|week|all] [--offset <number>].");
    const store = await CollectorStore.open(directory);
    try {
      const connection = store.connections().find(item => item.id === id);
      if (!connection) throw new Error("Select a retained connection from import status.");
      print({ sourceInstanceId: connection.source.instanceId, ...nativeUploadConversationPage(connection, await nativeUploadInventory(connection.source), {
        query: optionString(options, "query"), range: optionString(options, "range") || "all", offset: Number(optionString(options, "offset") || "0"),
      }) });
    } finally { store.close(); }
    return true;
  }
  if (action === "coverage") {
    if (!id) throw new Error("Use openpond import coverage <connection-id>.");
    const store = await CollectorStore.open(directory);
    try {
      if (!store.connections().some(connection => connection.id === id)) throw new Error("Select a retained connection from import status.");
      const manifest = store.coverage.manifest(id);
      if (!manifest) throw new Error("This connection has no retained source coverage. Run import sync first.");
      print({ manifest, summary: store.coverage.summary(id) });
    } finally { store.close(); }
    return true;
  }
  if (action === "cancel") { print(await controlCollector(directory, "stop")); return true; }
  if (action === "schedule") {
    if (!id) throw new Error("Use openpond import schedule <connection-id> --continual [--daily|--weekly|--hourly|--cron <expression>] or --off.");
    const schedule = importSchedule(options), off = parseBooleanOption(options.off);
    if (!schedule && !off) throw new Error("Choose --continual [--daily|--weekly|--hourly|--cron <expression>] or --off.");
    print(await setCollectorSchedule(collectorSetup(directory), id, schedule)); return true;
  }
  if (action === "sync") {
    const status = await collectorStatus(directory);
    if (id && !status.connections.some(connection => connection.id === id && connection.state === "active"))
      throw new Error("Select an active connection from import status; resume or reconnect it first.");
    if (!status.connections.some(connection => connection.state === "active")) throw new Error("No active sources. Connect or resume a source first.");
    const selectionFile = optionString(options, "selectionFile");
    if (selectionFile) {
      if (!id) throw new Error("Select a connection ID when uploading chosen conversations.");
      if (status.running) throw new Error("Wait for the running import or cancel it before selecting more conversations.");
      const store = await CollectorStore.open(directory);
      try {
        const connection = store.connections().find(item => item.id === id);
        if (!connection) throw new Error("The selected connection is unavailable.");
        let selected = await applyUploadSelection(connection, selectionFile);
        if (connection.since !== null) {
          const { sync } = await collectorClients(connection);
          const remote = await sync.register({ id: connection.id, source: connection.source.source,
            machineId: connection.source.machineId, sourceInstanceId: connection.source.instanceId,
            sourceLabel: NATIVE_SOURCE_NAMES[connection.source.source], sourceRoot: connection.source.root,
            destination: { kind: "existing", projectId: connection.projectId }, since: null,
            keepSyncing: connection.keepSyncing, expectedRevision: connection.revision });
          selected = { ...selected, revision: remote.revision, state: remote.state,
            requestedSyncRevision: remote.requestedSyncRevision, completedSyncRevision: remote.completedSyncRevision };
        }
        store.put(selected);
      } finally { store.close(); }
    } else if (!status.connections.some(connection => connection.state === "active" && (!id || connection.id === id) && connection.selectedConversations !== 0)) {
      throw new Error("Choose conversations first with --selection-file <path>.");
    }
    await runImportJob({ directory, connectionId: id, json, until: optionString(options, "until") || undefined }); return true;
  }
  if (action !== "service") return false;
  if (id === "status") print(await collectorStatus(directory));
  else if (id === "stop") print(await controlCollector(directory, "stop"));
  else if (id === "uninstall") print(await uninstallCollectorService(directory));
  else if (id === "install") print(await installCollectorService(collectorSetup(directory)));
  else if (id === "start") await runImportJob({ directory, json });
  else if (id === "run") await runImportJob({ directory, json, scheduled: parseBooleanOption(options.scheduled), retainedStart: !parseBooleanOption(options.scheduled) });
  else throw new Error("usage: openpond import service <install|start|stop|status|run|uninstall>");
  return true;
}
