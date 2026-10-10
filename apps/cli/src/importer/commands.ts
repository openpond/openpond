import { collectorStatus, controlCollector, setCollectorSchedule, uninstallCollectorService, installCollectorService, type CollectorServiceSetup } from "@openpond/evals/native-conversations";
import { parseBooleanOption, optionString } from "../cli/common";
import { runImportJob } from "./run";
import { importSchedule } from "./schedule";

export function collectorSetup(directory: string): CollectorServiceSetup {
  return { directory, executable: process.execPath, args: [...process.execArgv, process.argv[1]!],
    environment: { ...(process.env.OPENPOND_HOME ? { OPENPOND_HOME: process.env.OPENPOND_HOME } : {}),
      ...(process.env.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } };
}

export async function runImporterControl(directory: string, action: string, id: string | undefined, options: Record<string, string | boolean>) {
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const json = parseBooleanOption(options.json);
  if (action === "status") { print(await collectorStatus(directory)); return true; }
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
