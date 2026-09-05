import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { readConfig } from "./config.js";
import { openStorageDatabase } from "./database.js";
import { resolveConfigPath, storagePaths } from "./home.js";

export const placementTables = new Set(["sessions", "projection_session_shells", "sidebar_file_bookmarks", "saved_local_projects", "profile_installations", "extension_installations", "scaffold_registrations", "refiner_bindings", "harness_release_records", "dataset_artifacts", "dataset_import_jobs", "taskset_drafts", "taskset_draft_workspaces", "training_artifacts", "task_attempt_artifacts", "local_agent_schedules"]);
export function isWithinHome(file: string, home: string): boolean {
  const relative = path.relative(home, file);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Enumerates placement metadata only; transcripts, tool arguments and secrets are never scanned. */
export async function externalStorageReferences(home: string): Promise<{ path: string; available: boolean; included: false }[]> {
  const paths = new Set<string>(), config = (await readConfig(home)).document;
  function add(file: string): void { if (path.isAbsolute(file) && !isWithinHome(file, home)) paths.add(path.normalize(file)); }
  if (config.storage?.datasets_dir) add(resolveConfigPath(config.storage.datasets_dir, home));
  if (config.personalization?.user_instructions) add(resolveConfigPath(config.personalization.user_instructions, home));
  function visit(value: unknown, key = ""): void {
    if (typeof value === "string" && /(?:path|directory|root|cwd)$/i.test(key)) add(value);
    else if (Array.isArray(value)) for (const entry of value) visit(entry, key);
    else if (value && typeof value === "object") for (const [field, entry] of Object.entries(value)) {
      if (!["messages", "events", "turns", "metadata", "input", "output", "result", "credential"].includes(field)) visit(entry, field);
    }
  }
  const database = storagePaths(home).database;
  if (existsSync(database)) {
    const db = openStorageDatabase(database, true);
    try {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) if (placementTables.has(name)) {
        const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
        if (columns.some((entry) => entry.name === "payload")) for (const row of db.prepare(`SELECT payload FROM ${name}`).all() as { payload: string }[]) visit(JSON.parse(row.payload));
        for (const { name: column } of columns.filter((entry) => /(?:_path|_directory|_root)$/.test(entry.name) || entry.name === "cwd")) {
          for (const row of db.prepare(`SELECT "${column}" AS value FROM ${name}`).all() as { value: unknown }[]) if (typeof row.value === "string") add(row.value);
        }
      }
    } finally { db.close(); }
  }
  return Promise.all([...paths].sort().map(async (file) => ({ path: file, available: Boolean(await fs.stat(file).catch(() => null)), included: false as const })));
}
