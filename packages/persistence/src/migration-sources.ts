import type { MigrationResolutions } from "./migration-conflicts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistenceError, isMissing } from "./errors.js";

const execute = promisify(execFile);
export type MigrationOptions = { sourceAppHome?: string; sourceConfig?: string; sourceBrowserState?: string; dryRun?: boolean; resolutions?: MigrationResolutions };
export async function discoverMigrationSources(home: string, options: MigrationOptions) {
  const nightly = home === path.join(os.homedir(), ".openpond-nightly");
  const oldGlobal = nightly ? path.join(os.homedir(), ".openpond") : home;
  const appCandidates = [home, path.join(oldGlobal, nightly ? "openpond-app-nightly" : "openpond-app")].filter((root) => existsSync(path.join(root, "state.sqlite")) || existsSync(path.join(root, "providers.json")));
  const configCandidates = [...new Set([path.join(oldGlobal, "config.json"), path.join(home, "config", "config.json")])].filter(existsSync);
  const issues: { code: string; message: string; paths: string[] }[] = [];
  if (!options.sourceAppHome && appCandidates.length > 1) issues.push({ code: "AMBIGUOUS_APP_HOME", message: "Select the previous app home with --source-app-home.", paths: appCandidates });
  if (!options.sourceConfig && configCandidates.length > 1) issues.push({ code: "AMBIGUOUS_CONFIG", message: "Select the previous account configuration with --source-config.", paths: configCandidates });
  const sourceAppHome = options.sourceAppHome ? path.resolve(options.sourceAppHome) : appCandidates.length === 1 ? appCandidates[0] : undefined;
  const sourceConfig = options.sourceConfig ? path.resolve(options.sourceConfig) : configCandidates.length === 1 ? configCandidates[0] : undefined;
  for (const value of [sourceAppHome, sourceConfig, options.sourceBrowserState]) if (value && !existsSync(value)) throw new PersistenceError({ code: "MIGRATION_SOURCE_MISSING", path: value, message: "The selected migration source is unavailable.", action: "Correct the source path before retrying." });
  return { ...(sourceAppHome ? { sourceAppHome } : {}), ...(sourceConfig ? { sourceConfig } : {}), ...(options.sourceBrowserState ? { sourceBrowserState: path.resolve(options.sourceBrowserState) } : {}), issues, sourceCandidates: { appHomes: appCandidates, configs: configCandidates } };
}

/** Old releases do not participate in our lock. Check their open files before taking snapshots. */
export async function assertMigrationSourcesStopped(sourceHome?: string, sourceConfig?: string): Promise<void> {
  const targets = [sourceHome ? path.join(sourceHome, "state.sqlite") : null, sourceConfig].filter((value): value is string => Boolean(value));
  if (!targets.length) return;
  const fail = () => new PersistenceError({ code: "MIGRATION_SOURCE_BUSY", path: sourceHome ?? sourceConfig!, message: "A previous OpenPond process is still using the source installation.", action: "Close that installation and retry. No migration source has been changed." });
  if (process.platform === "linux") {
    for (const entry of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const directory = `/proc/${entry}/fd`;
        for (const fd of await fs.readdir(directory)) {
          const file = await fs.readlink(path.join(directory, fd)).catch((error) => { if (isMissing(error)) return ""; throw error; });
          if (targets.some((target) => file === target || file === `${target}-wal` || file === `${target}-shm`)) throw fail();
        }
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        if (isMissing(error)) continue;
        if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          const owner = await fs.stat(`/proc/${entry}`).catch((failure) => { if (isMissing(failure)) return null; throw failure; });
          if (owner && owner.uid === process.getuid?.()) {
            const command = await fs.readFile(`/proc/${entry}/cmdline`, "utf8").catch((failure) => { if (isMissing(failure)) return ""; throw failure; });
            const executable = path.basename(command.split("\0")[0] ?? "");
            const possibleWriter = /^(?:node|electron|openpond(?:-code)?)(?:\.exe)?$/i.test(executable) && !command.includes("--type=");
            if (possibleWriter || targets.some((target) => command.includes(target))) throw new PersistenceError({ code: "MIGRATION_OWNERSHIP_UNVERIFIED", path: sourceHome ?? sourceConfig!, message: "A possible previous runtime could not be inspected for open migration sources.", action: "Close the previous OpenPond processes and retry with process inspection available." });
          }
        } else throw error;
      }
    }
    return;
  }
  if (process.platform === "darwin") {
    try {
      const result = await execute("/usr/sbin/lsof", ["-F", "p", "--", ...targets], { maxBuffer: 1_000_000 });
      if (result.stdout.split("\n").some((line) => /^p\d+$/.test(line) && Number(line.slice(1)) !== process.pid)) throw fail();
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      if ((error as { code?: number }).code !== 1) throw new PersistenceError({ code: "MIGRATION_OWNERSHIP_UNVERIFIED", path: sourceHome ?? sourceConfig!, message: "OpenPond could not verify that the previous installation is stopped.", action: "Ensure lsof is available, close the previous app and retry." });
    }
    return;
  }
  if (process.platform === "win32") {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    try {
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { maxBuffer: 4_000_000 });
      const raw = JSON.parse(stdout) as unknown;
      const processes = Array.isArray(raw) ? raw : [raw];
      for (const item of processes as { ProcessId?: number; CommandLine?: string }[]) {
        if (!item.CommandLine || item.ProcessId === process.pid) continue;
        if (/(?:openpond|apps[\\/]server).*(?:serve|server|desktop)/i.test(item.CommandLine) && (targets.some((target) => item.CommandLine!.includes(target)) || (sourceHome && item.CommandLine.includes(sourceHome)))) throw fail();
      }
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError({ code: "MIGRATION_OWNERSHIP_UNVERIFIED", path: sourceHome ?? sourceConfig!, message: "OpenPond could not inspect previous runtime ownership.", action: "Close the previous app and enable local process inspection before retrying." });
    }
    return;
  }
  throw new PersistenceError({ code: "MIGRATION_OWNERSHIP_UNVERIFIED", path: sourceHome ?? sourceConfig!, message: "Automatic migration ownership checks are unavailable on this platform.", action: "Migrate this installation on a supported desktop platform." });
}
