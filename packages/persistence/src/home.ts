import { currentOpenPondHome } from "./home-context.js";
import os from "node:os";
import path from "node:path";
import { PersistenceError } from "./errors.js";

export function resolveOpenPondHome(options: { home?: string; channel?: "stable" | "nightly"; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.home?.trim() || (options.env ? undefined : currentOpenPondHome()) || env.OPENPOND_HOME?.trim();
  if (explicit) return path.resolve(expandHome(explicit));
  for (const name of ["OPENPOND_APP_HOME", "OPENPOND_CONFIG_DIR"] as const) {
    if (env[name]?.trim()) {
      throw new PersistenceError({ code: "RETIRED_HOME_OPTION", path: name, message: `${name} has been replaced by OPENPOND_HOME.`, action: "Set OPENPOND_HOME to the destination home. Use openpond config migrate --source-app-home to import a previous installation." });
    }
  }
  return path.join(os.homedir(), options.channel === "nightly" ? ".openpond-nightly" : ".openpond");
}

export function expandHome(value: string): string {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function storagePaths(home = resolveOpenPondHome()) {
  const root = path.resolve(home);
  return {
    home: root,
    config: path.join(root, "config.toml"),
    marker: path.join(root, "storage.json"),
    database: path.join(root, "state", "state.sqlite"),
    cache: path.join(root, "cache", "cache.sqlite"),
    credentials: path.join(root, "secrets", "credentials.json"),
    key: path.join(root, "secrets", "credentials.key"),
    token: path.join(root, "secrets", "server-token"),
    runtime: path.join(root, "runtime"),
    library: path.join(root, "library"),
    instructions: path.join(root, "instructions"),
  };
}

export function resolveConfigPath(value: string, root: string, allowHome = true): string {
  return path.resolve(root, allowHome ? expandHome(value) : value);
}
