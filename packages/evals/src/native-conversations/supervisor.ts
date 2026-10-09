import { randomUUID } from "node:crypto";
import { retainAppImageRuntime, removeAppImageRuntimes } from "./appimage-runtime.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { contentHash } from "@openpond/harness";
import { CollectorStore } from "./collector-store.js";
import { validateCollectorSchedule } from "./collector-schedule.js";
import { collectorServiceFiles } from "./collector-service-files.js";
import type { CollectorConnection, CollectorSchedule } from "./collector-contracts.js";
const execute = promisify(execFile);
const command = async (file: string, args: string[]) => {
  await execute(file, args, {
    timeout: 15000,
    maxBuffer: 16384,
    windowsHide: true,
  });
};
export interface CollectorServiceSetup {
  directory: string;
  executable: string;
  args: string[];
  home?: string;
  environment?: Partial<
    Record<"OPENPOND_HOME" | "ELECTRON_RUN_AS_NODE" | "APPIMAGE_EXTRACT_AND_RUN", string>
  >;
}
function identity(directory: string) {
  return `openpond-import-${contentHash(directory).slice(0, 16)}`;
}
export async function configureCollector(
  directory: string,
  connection: CollectorConnection,
) {
  const store = await CollectorStore.open(directory);
  try {
    store.put(connection);
  } finally {
    store.close();
  }
}
export async function collectorStatus(directory: string) {
  const store = await CollectorStore.open(directory);
  try {
    return store.status();
  } finally {
    store.close();
  }
}
export async function controlCollector(
  directory: string,
  action: "start" | "stop" | "sync" | "pause" | "resume" | "disconnect",
  connectionId?: string,
) {
  const store = await CollectorStore.open(directory);
  try {
    if (action === "start" || action === "stop")
      store.set("desiredState", action === "start" ? "running" : "stopped");
    else if (action === "sync") store.set("syncNow", "yes");
    else {
      const connection = store
        .connections()
        .find((item) => item.id === connectionId);
      if (!connection) throw new Error("Select a retained connection.");
      store.put({
        ...connection,
        state:
          action === "pause"
            ? "paused"
            : action === "resume"
              ? "active"
              : "disconnected",
      });
    }
    return store.status();
  } finally {
    store.close();
  }
}
/** Install calendar triggers only. Registration never launches an import. */
export async function installCollectorService(input: CollectorServiceSetup) {
  // Reloading a launchd calendar also terminates its active process. Preserve
  // the current import instead of silently cancelling it during a settings edit.
  if (process.platform === "darwin" && (await collectorStatus(input.directory)).running)
    throw new Error("Wait for the current import to finish, or cancel it, before changing its macOS schedule.");
  if (!isAbsolute(input.directory) || !isAbsolute(input.executable) ||
    [input.directory, input.executable, ...input.args].some(value => /[\r\n\0]/u.test(value)))
    throw new Error("Collector jobs require absolute paths and single-line arguments.");
  const retainedRuntime = await retainAppImageRuntime(input);
  if (retainedRuntime) input = { ...input, ...retainedRuntime, environment: { ...input.environment, ELECTRON_RUN_AS_NODE: "1", APPIMAGE_EXTRACT_AND_RUN: "1" } };
  const environment = Object.entries(input.environment ?? {}) as [string, string][];
  if (environment.some(([key, value]) => !["OPENPOND_HOME", "ELECTRON_RUN_AS_NODE", "APPIMAGE_EXTRACT_AND_RUN"].includes(key) || typeof value !== "string" || /[\r\n\0]/u.test(value)))
    throw new Error("Unsupported service environment setting.");
  const home = input.home ?? homedir(), name = identity(input.directory);
  const store = await CollectorStore.open(input.directory);
  let schedules: CollectorSchedule[];
  try { schedules = store.connections().map(connection => store.schedule(connection.id)).filter((schedule): schedule is CollectorSchedule => schedule !== null); }
  finally { store.close(); }
  const gatePath = join(input.directory, "calendar-gate.cjs");
  const files = collectorServiceFiles({ name, gatePath, executable: input.executable,
    args: [...input.args, "import", "service", "run", "--scheduled", "--collector-dir", input.directory], environment, schedules });
  await atomicServiceFile(gatePath, files.gate, { mode: 0o600 });
  if (process.platform === "linux") {
    const directory = join(home, ".config/systemd/user");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Remove the old login enablement without stopping an already owned job.
    await optionalCommand("systemctl", ["--user", "disable", `${name}.service`]);
    await atomicServiceFile(join(directory, `${name}.service`), files.service, { mode: 0o600 });
    if (schedules.length) {
      await atomicServiceFile(join(directory, `${name}.timer`), files.timer, { mode: 0o600 });
      await command("systemctl", ["--user", "daemon-reload"]);
      await command("systemctl", ["--user", "enable", "--now", `${name}.timer`]);
      await command("systemctl", ["--user", "restart", `${name}.timer`]);
    } else {
      await optionalCommand("systemctl", ["--user", "disable", "--now", `${name}.timer`]);
      await rm(join(directory, `${name}.timer`), { force: true });
      await command("systemctl", ["--user", "daemon-reload"]);
    }
  } else if (process.platform === "darwin") {
    const directory = join(home, "Library/LaunchAgents"), file = join(directory, `${name}.plist`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await optionalCommand("launchctl", ["bootout", `gui/${process.getuid!()}/${name}`]);
    if (schedules.length) {
      await atomicServiceFile(file, files.plist, { mode: 0o600 });
      await command("launchctl", ["bootstrap", `gui/${process.getuid!()}`, file]);
    } else await rm(file, { force: true });
  } else if (process.platform === "win32") {
    if (!schedules.length) await optionalCommand("schtasks", ["/Delete", "/TN", name, "/F"]);
    else {
      const user = (await execute("whoami", [], { timeout: 5000, maxBuffer: 1024 })).stdout.trim();
      const file = join(input.directory, "scheduled-task.xml"), script = join(input.directory, "start-collector.ps1");
      await mkdir(input.directory, { recursive: true, mode: 0o700 });
      await atomicServiceFile(script, files.powershell, { mode: 0o600 });
      await atomicServiceFile(file, files.windowsTask(user, script), { mode: 0o600 });
      await command("schtasks", ["/Create", "/TN", name, "/XML", file, "/F"]);
    }
  } else throw new Error("Scheduled imports need a supported OS scheduler. Use import sync manually on this OS.");
  return { name, platform: process.platform, status: await collectorStatus(input.directory) };
}

// Absence is allowed only when removing an optional trigger. Installation and
// activation failures remain errors and never claim that a schedule is enabled.
async function optionalCommand(file: string, args: string[]) {
  try { await command(file, args); }
  catch (error) {
    const result = error as Error & { stderr?: string; code?: string | number };
    if (result.code === "ENOENT" || !/not (?:loaded|found|exist)|does not exist|No such|could not be found|cannot find|not been loaded/iu.test(result.stderr ?? result.message)) throw error;
  }
}

/** Serialize OS/config updates; a failed installation restores retained intent. */
export async function setCollectorSchedule(input: CollectorServiceSetup, connectionId: string, schedule: CollectorSchedule | null) {
  if (schedule !== null) schedule = validateCollectorSchedule(schedule);
  if (process.platform === "darwin" && (await collectorStatus(input.directory)).running)
    throw new Error("Wait for the current import to finish, or cancel it, before changing its macOS schedule.");
  const store = await CollectorStore.open(input.directory), token = randomUUID();
  let prior: string | null;
  store.database.exec("BEGIN IMMEDIATE");
  try {
    const connection = store.connections().find(item => item.id === connectionId);
    if (!connection || (schedule && connection.state === "disconnected")) throw new Error("Select a connected source before scheduling imports.");
    const owner = store.setting("scheduleOwner");
    if (owner) {
      const { pid } = JSON.parse(owner) as { pid: number };
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (alive) throw new Error("Another schedule update is in progress. Try again shortly.");
    }
    prior = store.setting(`schedule:${connectionId}`);
    store.set("scheduleOwner", JSON.stringify({ pid: process.pid, token }));
    store.set(`schedule:${connectionId}`, schedule ? JSON.stringify(schedule) : "");
    store.database.exec("COMMIT");
  } catch (error) { store.database.exec("ROLLBACK"); store.close(); throw error; }
  try {
    await installCollectorService(input);
    return store.status();
  } catch (error) {
    store.set(`schedule:${connectionId}`, prior ?? "");
    try { await installCollectorService(input); }
    catch { throw new Error(`Schedule installation failed and OS rollback could not be verified. Review the OS scheduler. ${error instanceof Error ? error.message : ""}`); }
    throw error;
  } finally { store.set("scheduleOwner", ""); store.close(); }
}
/** Removing supervision preserves receipts, pending uploads and retained datasets. */
export async function uninstallCollectorService(
  directory: string,
  home = homedir(),
) {
  await controlCollector(directory, "stop");
  const name = identity(directory);
  if (process.platform === "linux") {
    await optionalCommand("systemctl", ["--user", "disable", "--now", `${name}.timer`]);
    await rm(join(home, ".config/systemd/user", `${name}.timer`), { force: true });
    await command("systemctl", ["--user", "disable", "--now", `${name}.service`]);
    await rm(join(home, ".config/systemd/user", `${name}.service`), {
      force: true,
    });
    await command("systemctl", ["--user", "daemon-reload"]);
  } else if (process.platform === "darwin") {
    await command("launchctl", ["bootout", `gui/${process.getuid!()}/${name}`]);
    await rm(join(home, "Library/LaunchAgents", `${name}.plist`), {
      force: true,
    });
  } else if (process.platform === "win32") {
    await command("schtasks", ["/End", "/TN", name]);
    await command("schtasks", ["/Delete", "/TN", name, "/F"]);
    await rm(join(directory, "scheduled-task.xml"), { force: true });
    await rm(join(directory, "start-collector.ps1"), { force: true });
  } else throw new Error("No per-user supervisor is available.");
  await rm(join(directory, "calendar-gate.cjs"), { force: true });
  if (process.platform === "linux") await removeAppImageRuntimes(directory);
  const store = await CollectorStore.open(directory);
  try { for (const connection of store.connections()) store.set(`schedule:${connection.id}`, ""); }
  finally { store.close(); }
  return collectorStatus(directory);
}

async function atomicServiceFile(file: string, text: string, options: { mode: number }) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { ...options, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
