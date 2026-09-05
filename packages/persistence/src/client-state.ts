import { createHash } from "node:crypto";
import { readConfig, updateConfig } from "./config.js";
import { getLocalRecord, withLocalDatabase } from "./database.js";
import { ClientChoicesSchema, type ClientChoices } from "./schemas/client-state.js";
import path from "node:path";
import { withFileLock } from "./private-file.js";
import { storagePaths } from "./home.js";
import { PersistenceError } from "./errors.js";

async function scope(home: string): Promise<string> {
  const config = await readConfig(home);
  const identity = config.document.defaults?.account_id ?? getLocalRecord(home, "account_selection", "last_used")?.value ?? "local";
  return `choices:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
export async function readClientChoices(home: string) {
  const owner = await scope(home), stored = getLocalRecord<ClientChoices>(home, "client_preferences", owner);
  const config = await readConfig(home);
  return { owner, revision: stored?.revision ?? null, value: ClientChoicesSchema.parse({ ...stored?.value, notificationMode: config.document.notifications?.team_chat ?? "all" }) };
}
/** Layout edits merge only the submitted fields; stale clients cannot replace another field. */
export async function updateClientChoices(home: string, owner: string, patch: ClientChoices, importOnly = false) {
  return withFileLock(path.join(storagePaths(home).runtime, "accounts"), async () => {
  const changes = ClientChoicesSchema.parse(patch);
  if (await scope(home) !== owner) throw new PersistenceError({ code: "CLIENT_OWNER_CHANGED", path: "client_preferences", message: "The active account changed before this preference was saved.", action: "Reload preferences for the current account." });
  const { notificationMode, ...layoutChanges } = changes;
  if (notificationMode !== undefined) await updateConfig(home, (config) => importOnly && config.notifications?.team_chat !== undefined ? config : { ...config, notifications: { ...config.notifications, team_chat: notificationMode } });
  withLocalDatabase(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT payload, revision FROM client_preferences WHERE id=?").get(owner) as { payload: string; revision: number } | undefined;
      const current: ClientChoices = row ? JSON.parse(row.payload) : {};
      delete current.notificationMode;
      const value = ClientChoicesSchema.parse(importOnly ? { ...layoutChanges, ...current } : { ...current, ...layoutChanges });
      db.prepare("INSERT INTO client_preferences VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=revision+1").run(owner, JSON.stringify(value));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
  return readClientChoices(home);
  });
}
