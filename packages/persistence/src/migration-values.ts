import { createDecipheriv, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, readOptionalFile, atomicWriteFile } from "./private-file.js";
import { type ConfigDocument, validateConfigDocument } from "./config-schema.js";
import { preferencesToConfig, layoutPreferences } from "./preference-config.js";
import { AppPreferencesSchema, PERSONALIZATION_TEMPLATES } from "./schemas/settings.js";
import { ProviderSettingsSchema } from "./schemas/providers.js";
import { updateAccountConfiguration, type PersistedAccountConfiguration } from "./accounts.js";
import { readConfig, updateConfig, mergeConfig } from "./config.js";
import { writeCredential } from "./credentials.js";
import { putLocalRecord, openStorageDatabase, PERSISTENCE_TABLES_SQL } from "./database.js";
import { storagePaths } from "./home.js";
import { writeCache } from "./cache.js";
import { ImportedProviderSecretsSchema, ImportedOAuthSchema, ImportedPersonalitySchema, ImportedDatasetSettingsSchema, assertNoUnmappedFields, normalizeImportedPreferences, validateImportedAccounts } from "./migration-validation.js";
import { PersistenceError } from "./errors.js";

export function migrationConflict(filePath: string, message: string): PersistenceError {
  return new PersistenceError({ code: "MIGRATION_CONFLICT", path: filePath, message, action: "Open migration details, resolve this conflict, and retry. The source installation has been preserved." });
}

export async function importAccountConfig(stage: string, source: string | undefined): Promise<void> {
  if (!source) return;
  const raw = await readJsonFile<Record<string, unknown>>(source, () => ({}));
  const allowed = new Set(["accounts", "activeProfile", "openpondProfile", "baseUrl", "apiBaseUrl", "chatApiBaseUrl", "apiKey", "token", "appId", "conversationId", "lspEnabled", "executionMode", "mode"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw migrationConflict(source, `Unmapped account configuration field: ${key}`);
  validateImportedAccounts(raw, source);
  let accounts = raw.accounts as PersistedAccountConfiguration["accounts"];
  if (accounts !== undefined && !Array.isArray(accounts)) throw migrationConflict(source, "The account list is invalid.");
  if (!accounts?.length && (raw.apiKey || raw.token || raw.baseUrl)) accounts = [{ handle: (raw.activeProfile as { handle?: string } | undefined)?.handle ?? "default", ...(raw as object), session: { token: raw.token as string | undefined, appId: raw.appId as string | null | undefined, conversationId: raw.conversationId as string | null | undefined } }];
  const value: PersistedAccountConfiguration = { ...raw, accounts };
  await updateAccountConfiguration(stage, () => value);
}

type OldCache = { type: string; cache_key: string; payload: string; updated_at: string; error: string | null };
export async function importPreferenceRecords(stage: string, originalHome: string | undefined): Promise<void> {
  const file = storagePaths(stage).database;
  const exists = await fs.stat(file).catch(() => null);
  if (!exists) return;
  const db = openStorageDatabase(file);
  let entries: OldCache[] = [];
  try {
    db.exec(PERSISTENCE_TABLES_SQL);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cache_entries'").get()) entries = db.prepare("SELECT type, cache_key, payload, updated_at, error FROM cache_entries").all() as OldCache[];
  } finally { db.close(); }
  for (const row of entries) {
    const value = JSON.parse(row.payload) as unknown;
    if (row.type === "app_preferences") {
      const raw = value as Record<string, unknown>;
      for (const key of Object.keys(raw)) if (!(key in AppPreferencesSchema.shape)) throw migrationConflict(file, `Unmapped preference field: ${key}`);
      const prefs = normalizeImportedPreferences(value, file);
      const currentConfig = (await readConfig(stage)).document;
      if (raw.editor && currentConfig.editor?.language_servers && currentConfig.editor.language_servers !== prefs.editor.languageServers) throw migrationConflict(file, "CLI language-server configuration conflicts with saved editor settings.");
      if (prefs.defaultChatModelRef && (prefs.defaultChatModelRef.providerId !== prefs.defaultChatProvider || prefs.defaultChatModelRef.modelId !== prefs.defaultChatModel)) throw migrationConflict(file, "Saved model fields disagree; select which model should be retained.");
      await updateConfig(stage, (current) => mergeConfig(current, preferencesToConfig(prefs)));
      putLocalRecord(stage, "client_preferences", "global", layoutPreferences(prefs));
    } else if (row.type === "local.projects") {
      if (!Array.isArray(value)) throw migrationConflict(file, "Saved projects must be an array.");
      for (const project of value as { id: string }[]) {
        if (!project || typeof project.id !== "string") throw migrationConflict(file, "A saved project has no identity.");
        putLocalRecord(stage, "saved_local_projects", project.id, project);
      }
    }
    else if (row.type === "codex_history.sidebar_preferences") putLocalRecord(stage, "codex_sidebar_state", row.cache_key, value);
    else if (row.type === "personalization") putLocalRecord(stage, "account_selection", "imported_personality", value);
    else if (row.type === "openpond.scaffoldApps") putLocalRecord(stage, "scaffold_registrations", row.cache_key, value);
    else if (["openpond.account", "openpond.apps", "openpond.cloudProjects", "training.hosted-model-project-catalog.v1"].includes(row.type)) await writeCache(stage, row.type, row.cache_key, value, { error: row.error });
    else throw migrationConflict(file, `Unmapped cache namespace: ${row.type}`);
  }
  const cleaned = openStorageDatabase(file);
  try { if (entries.length) cleaned.exec("DELETE FROM cache_entries"); cleaned.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { cleaned.close(); }
  void originalHome;
}

export async function importProviderConfig(stage: string, sourceHome?: string): Promise<void> {
  if (!sourceHome) return;
  const file = path.join(sourceHome, "providers.json"), raw = await readJsonFile<Record<string, unknown>>(file, () => ({}));
  for (const key of Object.keys(raw)) if (!["version", "providers", "modelCaches", "catalogCache", "statuses", "updatedAt"].includes(key)) throw migrationConflict(file, `Unmapped provider field: ${key}`);
  const parsed = ProviderSettingsSchema.parse(raw);
  assertNoUnmappedFields(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "catalogCache")), parsed, file);
  const providers: NonNullable<ConfigDocument["providers"]> = {};
  for (const [id, entry] of Object.entries(parsed.providers)) providers[id] = { enabled: entry.enabled, ...(entry.baseUrl ? { base_url: entry.baseUrl } : {}), ...(entry.defaultModel ? { default_model: entry.defaultModel } : {}), model_overrides: entry.modelOverrides };
  await updateConfig(stage, (current) => ({ ...current, providers }));
  await writeCache(stage, "providers", "catalog", { modelCaches: parsed.modelCaches, catalogCache: raw.catalogCache ?? null });
  const secretFile = path.join(sourceHome, "provider-secrets.json");
  const rawSecrets = await readJsonFile<unknown>(secretFile, () => null);
  if (rawSecrets === null) return;
  const parsedSecrets = ImportedProviderSecretsSchema.safeParse(rawSecrets);
  if (!parsedSecrets.success) throw migrationConflict(secretFile, "The provider vault has an unsupported version or field.");
  const secrets = parsedSecrets.data;
  const keyText = await readOptionalFile(path.join(sourceHome, "provider-secrets.key"));
  const key = keyText ? Buffer.from(keyText.trim(), "base64") : null;
  for (const [id, record] of Object.entries(secrets.providers)) {
    let value: string | null = null, oauth: unknown = null;
    if (record.source !== "env") {
      if (!key || key.length !== 32 || !record.ciphertext || !record.iv || !record.tag) throw migrationConflict(secretFile, "The old provider credential cannot be decrypted with its saved key.");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(record.iv), "base64"));
        decipher.setAuthTag(Buffer.from(String(record.tag), "base64"));
        value = Buffer.concat([decipher.update(Buffer.from(String(record.ciphertext), "base64")), decipher.final()]).toString("utf8");
        if (record.source === "chatgpt_subscription") { oauth = ImportedOAuthSchema.parse(JSON.parse(value)); value = null; }
      } catch { throw migrationConflict(secretFile, "The saved provider credential failed integrity verification."); }
    }
    const credentialId = `provider:${id}`;
    const imported = { endpoint: providers[id]?.base_url ?? null, source: record.source, value, oauth, envVar: record.envVar ?? null, createdAt: record.createdAt, updatedAt: record.updatedAt, lastValidatedAt: record.lastValidatedAt ?? null, lastError: record.lastError ?? null };
    await writeCredential(stage, credentialId, imported, null);
    await updateConfig(stage, (current) => ({ ...current, providers: { ...current.providers, [id]: { ...current.providers?.[id], credential: record.source === "env" ? { source: "env", name: String(record.envVar) } : { source: "secret", id: credentialId } } } }));
  }
}

export async function importPersonalization(stage: string, sourceHome?: string): Promise<void> {
  if (!sourceHome) return;
  const templates = new Map<string, { id: string; content: string }>();
  for (const directory of [sourceHome, path.join(sourceHome, "souls")]) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !(directory === sourceHome ? /^soul-.+\.md$/i : /\.md$/i).test(entry.name)) continue;
      const content = await fs.readFile(path.join(directory, entry.name), "utf8");
      const id = `imported-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
      await preserveImportedPersonality(stage, id, content);
      templates.set(`file:${path.relative(sourceHome, path.join(directory, entry.name)).split(path.sep).join("/")}`, { id, content });
    }
  }
  const activeSoul = await readOptionalFile(path.join(sourceHome, "SOUL.md"));
  const stateFile = path.join(sourceHome, "personalization.json");
  const rawState = await readJsonFile<unknown>(stateFile, () => null);
  const parsedState = rawState === null ? null : ImportedPersonalitySchema.safeParse(rawState);
  if (parsedState && !parsedState.success) throw migrationConflict(stateFile, "Personalization has an unsupported version or field.");
  const personalization: { activeTemplateId?: string } = parsedState?.success ? parsedState.data : {};
  const { getLocalRecord } = await import("./database.js");
  const selected = getLocalRecord<string>(stage, "account_selection", "imported_personality")?.value ?? personalization.activeTemplateId ?? "default";
  const template = templates.get(selected);
  const builtin = PERSONALIZATION_TEMPLATES.find((entry) => entry.id === selected);
  let active = template ? `custom:${template.id}` : builtin ? `builtin:${builtin.id}` : "builtin:default";
  if (activeSoul?.trim() && !template && !builtin) {
    const id = `imported-${createHash("sha256").update(activeSoul).digest("hex").slice(0, 16)}`;
    await preserveImportedPersonality(stage, id, activeSoul);
    active = `custom:${id}`;
  } else if (activeSoul?.trim() && activeSoul.trim() !== (template?.content ?? builtin?.content)?.trim()) {
    const id = `preserved-${createHash("sha256").update(activeSoul).digest("hex").slice(0, 16)}`;
    await preserveImportedPersonality(stage, id, activeSoul);
  }
  await updateConfig(stage, (config) => ({ ...config, personalization: { ...config.personalization, active } }));
}

export async function importDatasetPreference(stage: string, sourceHome?: string): Promise<void> {
  if (!sourceHome) return;
  const settingsFile = path.join(sourceHome, "datasets", "settings.json");
  const rawSettings = await readJsonFile<unknown>(settingsFile, () => null);
  const parsedSettings = rawSettings === null ? null : ImportedDatasetSettingsSchema.safeParse(rawSettings);
  if (parsedSettings && !parsedSettings.success) throw migrationConflict(settingsFile, "Dataset settings have an unsupported version or field.");
  const settings: { datasetStorePath?: string } = parsedSettings?.success ? parsedSettings.data : {};
  if (settings.datasetStorePath) await updateConfig(stage, (config) => ({ ...config, storage: { ...config.storage, datasets_dir: settings.datasetStorePath } }));
  validateConfigDocument((await readConfig(stage)).document);
}

async function preserveImportedPersonality(stage: string, id: string, content: string): Promise<void> {
  await atomicWriteFile(path.join(stage, "instructions", "imported-originals", `${id}.md`), content);
  // The previous runtime used trimmed text capped at 8,000 characters.
  await atomicWriteFile(path.join(stage, "instructions", "personalities", `${id}.md`), content.trim().slice(0, 8000));
}
