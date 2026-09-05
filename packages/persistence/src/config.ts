import { rememberValidConfig } from "./config-recovery.js";
import { watch } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validateConfigDocument, type ConfigDocument, type ConfigOperation, type ConfigScope } from "./config-schema.js";
import { PersistenceError } from "./errors.js";
import { atomicWriteFile, fileRevision, readOptionalFile, withFileLock } from "./private-file.js";
import { parseToml, editToml, diffConfig, isRecord } from "./toml-edit.js";
import { storagePaths, resolveOpenPondHome } from "./home.js";

export type ConfigSnapshot = { path: string; rawRevision: string; document: ConfigDocument };
export async function readConfig(home = resolveOpenPondHome(), options: { path?: string; scope?: ConfigScope } = {}): Promise<ConfigSnapshot> {
  const filePath = options.path ?? storagePaths(home).config;
  const text = await readOptionalFile(filePath);
  return { path: filePath, rawRevision: fileRevision(text), document: validate(text === null ? { schema_version: 1 } : parseToml(text, filePath).value, filePath, options.scope) };
}

function validate(value: unknown, filePath: string, scope?: ConfigScope): ConfigDocument {
  try { return validateConfigDocument(value, scope); }
  catch (cause) {
    const message = cause instanceof z.ZodError ? cause.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ") : cause instanceof Error ? cause.message : "Invalid configuration";
    throw new PersistenceError({ code: "INVALID_CONFIG", path: filePath, message, action: "Open the configuration file and correct the indicated setting." }, { cause });
  }
}

export async function patchConfig(home: string, expectedRawRevision: string, operations: ConfigOperation[], options: { path?: string; scope?: ConfigScope } = {}): Promise<ConfigSnapshot> {
  const filePath = options.path ?? storagePaths(home).config;
  return withFileLock(filePath, async () => {
    const original = await readOptionalFile(filePath);
    if (fileRevision(original) !== expectedRawRevision) throw conflict(filePath);
    const current = await readConfig(home, options);
    if (current.rawRevision !== expectedRawRevision) throw conflict(filePath);
    const candidate = editToml(original ?? "schema_version = 1\n", operations, filePath);
    const document = validate(parseToml(candidate, filePath).value, filePath, options.scope);
    if (fileRevision(await readOptionalFile(filePath)) !== expectedRawRevision) throw conflict(filePath);
    if (candidate !== original) { await rememberValidConfig(home, original); await atomicWriteFile(filePath, candidate); }
    return { path: filePath, rawRevision: fileRevision(candidate), document };
  });
}

export async function updateConfig(home: string, update: (current: ConfigDocument) => ConfigDocument | Promise<ConfigDocument>, expectedRevision?: string): Promise<ConfigSnapshot> {
  const filePath = storagePaths(home).config;
  return withFileLock(filePath, async () => {
    const current = await readConfig(home);
    if (expectedRevision !== undefined && current.rawRevision !== expectedRevision) throw conflict(filePath);
    const next = validate(await update(structuredClone(current.document)), filePath);
    const operations = diffConfig(current.document, next);
    if (!operations.length) return current;
    const original = await readOptionalFile(filePath);
    if (fileRevision(original) !== current.rawRevision) throw conflict(filePath);
    const candidate = editToml(original ?? "schema_version = 1\n", operations, filePath);
    validate(parseToml(candidate, filePath).value, filePath);
    if (fileRevision(await readOptionalFile(filePath)) !== current.rawRevision) throw conflict(filePath);
    await rememberValidConfig(home, original);
    await atomicWriteFile(filePath, candidate);
    return { path: filePath, rawRevision: fileRevision(candidate), document: next };
  });
}

function conflict(filePath: string): PersistenceError {
  return new PersistenceError({ code: "CONFIG_CONFLICT", path: filePath, message: "Configuration changed since this edit began.", action: "Reload the latest settings and apply your change again." });
}

export function mergeConfig(base: ConfigDocument, overlay: Partial<ConfigDocument>): ConfigDocument {
  return mergeTable(base, overlay) as ConfigDocument;
}
function mergeTable(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    if (isRecord(value) && isRecord(result[key]) && !("mode" in value) && !("source" in value) && !("provider_id" in value)) result[key] = mergeTable(result[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}

export function watchConfig(home: string, changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(path.dirname(storagePaths(home).config), { persistent: false }, (_event, filename) => {
    if (filename && String(filename) !== "config.toml") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(changed, 100);
    timer.unref();
  });
  watcher.on("error", changed);
  return () => { if (timer) clearTimeout(timer); watcher.close(); };
}
