import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigSchema, validateConfigDocument } from "./config-schema.js";
import { parseToml } from "./toml-edit.js";
import { storagePaths } from "./home.js";
import { PersistenceError, isMissing } from "./errors.js";
import { atomicWriteFile, fileRevision, readOptionalFile, withFileLock } from "./private-file.js";
import { z } from "zod";

export function validateConfigText(text: string, filePath = "config.toml", scope: "user" | "project" = "user") {
  return validateConfigDocument(parseToml(text, filePath).value, scope);
}
export async function rememberValidConfig(home: string, text: string | null): Promise<void> {
  if (text === null) return;
  try { validateConfigText(text); } catch { return; }
  const directory = path.join(home, "backups", "config");
  const filePath = path.join(directory, `${fileRevision(text)}.toml`);
  if (await readOptionalFile(filePath) === null) await atomicWriteFile(filePath, text);
  const files = await configRecoveryRevisions(home);
  for (const entry of files.slice(32)) await fs.rm(path.join(directory, `${entry.revision}.toml`));
}
export async function configRecoveryRevisions(home: string): Promise<{ revision: string; createdAt: string }[]> {
  const directory = path.join(home, "backups", "config");
  const names = await fs.readdir(directory).catch((error) => { if (isMissing(error)) return []; throw error; });
  const entries: { revision: string; createdAt: string }[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.toml$/.test(name)) continue;
    const file = path.join(directory, name), text = await readOptionalFile(file);
    if (!text || fileRevision(text) !== name.slice(0, -5)) continue;
    try { validateConfigText(text, file); } catch { continue; }
    entries.push({ revision: name.slice(0, -5), createdAt: (await fs.stat(file)).mtime.toISOString() });
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function replaceConfigText(home: string, expectedRevision: string, text: string): Promise<{ rawRevision: string }> {
  const filePath = storagePaths(home).config;
  validateConfigText(text, filePath);
  return withFileLock(filePath, async () => {
    const original = await readOptionalFile(filePath);
    if (original) {
      let existing: unknown;
      try { existing = parseToml(original, filePath).value; } catch { /* Syntax errors remain repairable. */ }
      if (existing && typeof existing === "object" && "schema_version" in existing && typeof existing.schema_version === "number" && existing.schema_version > 1) throw new PersistenceError({ code: "UNSUPPORTED_CONFIG_VERSION", path: filePath, message: "This configuration was written for a newer OpenPond version.", action: "Update OpenPond or restore a compatible backup into a separate home." });
    }
    if (fileRevision(original) !== expectedRevision) throw new PersistenceError({ code: "CONFIG_CONFLICT", path: filePath, message: "Configuration changed since you opened it.", action: "Reload the file before saving." });
    await rememberValidConfig(home, original);
    if (fileRevision(await readOptionalFile(filePath)) !== expectedRevision) throw new PersistenceError({ code: "CONFIG_CONFLICT", path: filePath, message: "Configuration changed while saving.", action: "Reload the file before saving." });
    await atomicWriteFile(filePath, text);
    return { rawRevision: fileRevision(text) };
  });
}
export async function restoreConfigRevision(home: string, revision: string, expectedRevision: string) {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid configuration revision.");
  const file = path.join(home, "backups", "config", `${revision}.toml`), text = await readOptionalFile(file);
  if (!text || fileRevision(text) !== revision) throw new PersistenceError({ code: "INVALID_CONFIG_BACKUP", path: file, message: "This configuration backup is unavailable or changed.", action: "Select another verified revision." });
  return replaceConfigText(home, expectedRevision, text);
}
export function configEditorSchema(): unknown { return z.toJSONSchema(ConfigSchema); }
