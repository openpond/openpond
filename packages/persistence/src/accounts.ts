import { createHash } from "node:crypto";
import { readConfig, updateConfig, type ConfigSnapshot } from "./config.js";
import { readCredential, writeCredential, newCredentialId, deleteCredential } from "./credentials.js";
import { getLocalRecord, withLocalDatabase } from "./database.js";
import { storagePaths } from "./home.js";
import { withFileLock } from "./private-file.js";
import { PersistenceError } from "./errors.js";

export type PersistedAccountView = {
  handle: string; baseUrl?: string; apiBaseUrl?: string; chatApiBaseUrl?: string; environment?: string; apiKey?: string;
  session?: { token?: string; appId?: string | null; conversationId?: string | null };
};
export type PersistedAccountConfiguration = {
  accounts?: PersistedAccountView[];
  activeProfile?: { handle: string; baseUrl?: string | null };
  openpondProfile?: unknown;
  lspEnabled?: boolean;
  executionMode?: "local" | "hosted";
  mode?: "general" | "builder";
};
type AccountSecrets = { apiKey?: string; token?: string; context?: string };
function credentialContext(account: { handle: string; base_url?: string; api_base_url?: string; chat_api_base_url?: string }): string { return createHash("sha256").update(JSON.stringify([account.handle, account.base_url ?? null, account.api_base_url ?? null, account.chat_api_base_url ?? null])).digest("hex"); }
type AccountSession = { appId?: string | null; conversationId?: string | null };

export function accountId(handle: string, baseUrl?: string): string {
  return `account-${createHash("sha256").update(JSON.stringify([handle.trim().toLowerCase(), baseUrl?.trim().replace(/\/$/, "") ?? ""])).digest("hex").slice(0, 24)}`;
}

export async function readAccountConfiguration(home: string): Promise<PersistedAccountConfiguration> {
  return withFileLock(`${storagePaths(home).runtime}/accounts`, () => readUnlocked(home));
}
async function readUnlocked(home: string, snapshot?: ConfigSnapshot): Promise<PersistedAccountConfiguration> {
  const { document } = snapshot ?? await readConfig(home);
  const accounts: PersistedAccountView[] = [];
  for (const [id, account] of Object.entries(document.accounts ?? {})) {
    if (account.enabled === false) continue;
    let secret: AccountSecrets = {};
    if (account.credential?.source === "secret") {
      const stored = await readCredential<AccountSecrets>(home, account.credential.id);
      if (!stored) throw new PersistenceError({ code: "CREDENTIAL_MISSING", path: storagePaths(home).config, message: `The credential referenced by account ${id} is unavailable.`, action: "Reconnect this account or restore its credential backup." });
      secret = stored.value.context === credentialContext(account) ? stored.value : {};
    } else if (account.credential?.source === "env") secret = { apiKey: process.env[account.credential.name] };
    const session = getLocalRecord<AccountSession>(home, "account_sessions", id)?.value;
    accounts.push({ handle: account.handle, ...(account.base_url ? { baseUrl: account.base_url } : {}), ...(account.api_base_url ? { apiBaseUrl: account.api_base_url } : {}), ...(account.chat_api_base_url ? { chatApiBaseUrl: account.chat_api_base_url } : {}), ...(account.environment ? { environment: account.environment } : {}), ...(secret.apiKey ? { apiKey: secret.apiKey } : {}), ...((session || secret.token) ? { session: { ...session, ...(secret.token ? { token: secret.token } : {}) } } : {}) });
  }
  const selected = document.defaults?.account_id ? document.accounts?.[document.defaults.account_id] : undefined;
  if (document.defaults?.account_id && (!selected || selected.enabled === false)) throw new PersistenceError({ code: "INVALID_ACCOUNT_DEFAULT", path: storagePaths(home).config, message: "The configured default account is missing or disabled.", action: "Choose an enabled default account or remove defaults.account_id." });
  const activeProfile = selected ? { handle: selected.handle, baseUrl: selected.base_url } : getLocalRecord<PersistedAccountConfiguration["activeProfile"]>(home, "account_selection", "last_used")?.value;
  let profile = getLocalRecord<unknown>(home, "profile_installations", "library")?.value;
  const pinnedProfile = document.defaults?.profile_ref;
  if (pinnedProfile) {
    const library = profile as { profiles?: { source: string; repositoryId: string; profile: string; repoPath: string }[] } | undefined;
    const entry = library?.profiles?.find((entry) => entry.source === pinnedProfile.source && entry.repositoryId === pinnedProfile.repository_id && entry.profile === pinnedProfile.profile_id);
    if (!entry) throw new PersistenceError({ code: "INVALID_PROFILE_DEFAULT", path: storagePaths(home).config, message: "The configured default Profile is not installed.", action: "Install that Profile or remove defaults.profile_ref." });
    profile = { ...library, repoPath: entry.repoPath, profile: entry.profile, mode: "local" };
  }
  return { accounts, ...(activeProfile ? { activeProfile } : {}), ...(profile ? { openpondProfile: profile } : {}),
    ...(document.editor?.language_servers ? { lspEnabled: document.editor.language_servers !== "off" } : {}),
    ...(document.runtime?.execution_mode ? { executionMode: document.runtime.execution_mode } : {}), ...(document.runtime?.mode ? { mode: document.runtime.mode } : {}) };
}

/** A composed API view; secrets and mutable records are never serialized into TOML. */
export async function updateAccountConfiguration(home: string, change: (value: PersistedAccountConfiguration) => PersistedAccountConfiguration | Promise<PersistedAccountConfiguration>): Promise<PersistedAccountConfiguration> {
  return withFileLock(`${storagePaths(home).runtime}/accounts`, async () => {
    const snapshot = await readConfig(home);
    const before = snapshot.document;
    const current = await readUnlocked(home, snapshot);
    const next = await change(structuredClone(current));
    const sessions = new Map<string, AccountSession>();
    const definitions: NonNullable<typeof before.accounts> = Object.fromEntries(Object.entries(before.accounts ?? {}).filter(([, value]) => value.enabled === false));
    const seen = new Set<string>();
    for (const account of next.accounts ?? []) {
      const identity = accountId(account.handle, account.baseUrl);
      if (seen.has(identity)) throw new PersistenceError({ code: "DUPLICATE_ACCOUNT", path: storagePaths(home).config, message: "Two accounts have the same handle and service endpoint.", action: "Resolve the duplicate accounts before saving." });
      seen.add(identity);
      const id = Object.entries(before.accounts ?? {}).find(([, value]) => accountId(value.handle, value.base_url) === accountId(account.handle, account.baseUrl))?.[0] ?? accountId(account.handle, account.baseUrl);
      const previous = before.accounts?.[id];
      const secrets: AccountSecrets = { ...(account.apiKey ? { apiKey: account.apiKey } : {}), ...(account.session?.token ? { token: account.session.token } : {}) };
      let credential = previous?.credential;
      const old = current.accounts?.find((entry) => accountId(entry.handle, entry.baseUrl) === accountId(account.handle, account.baseUrl));
      if (old?.apiKey !== account.apiKey || old?.session?.token !== account.session?.token || (!credential && Object.keys(secrets).length)) {
        credential = undefined;
        if (Object.keys(secrets).length) {
          const credentialId = newCredentialId(id);
          await writeCredential(home, credentialId, { ...secrets, context: credentialContext({ handle: account.handle, base_url: account.baseUrl, api_base_url: account.apiBaseUrl, chat_api_base_url: account.chatApiBaseUrl }) }, null);
          credential = { source: "secret", id: credentialId };
        }
      }
      definitions[id] = { ...(previous?.enabled === undefined ? {} : { enabled: previous.enabled }), handle: account.handle, ...(account.baseUrl ? { base_url: account.baseUrl } : {}), ...(account.apiBaseUrl ? { api_base_url: account.apiBaseUrl } : {}), ...(account.chatApiBaseUrl ? { chat_api_base_url: account.chatApiBaseUrl } : {}), ...(account.environment ? { environment: account.environment } : {}), ...(credential ? { credential } : {}) };
      if (account.session) sessions.set(id, { appId: account.session.appId ?? null, conversationId: account.session.conversationId ?? null });
    }
    await updateConfig(home, (document) => ({ ...document, accounts: definitions,
      ...(next.lspEnabled === undefined ? {} : { editor: { ...document.editor, language_servers: next.lspEnabled ? "auto" : "off" } }),
      ...(next.executionMode || next.mode ? { runtime: { ...document.runtime, ...(next.executionMode ? { execution_mode: next.executionMode } : {}), ...(next.mode ? { mode: next.mode } : {}) } } : {}) }), snapshot.rawRevision);
    withLocalDatabase(home, (db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of new Set([...Object.keys(before.accounts ?? {}), ...Object.keys(definitions)])) {
          const value = sessions.get(id);
          if (value) db.prepare("INSERT INTO account_sessions VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=revision+1").run(id, JSON.stringify(value));
          else db.prepare("DELETE FROM account_sessions WHERE id = ?").run(id);
        }
        if (JSON.stringify(current.activeProfile) !== JSON.stringify(next.activeProfile)) db.prepare("INSERT INTO account_selection VALUES ('last_used', ?, 1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=revision+1").run(JSON.stringify(next.activeProfile ?? null));
        if (JSON.stringify(current.openpondProfile) !== JSON.stringify(next.openpondProfile)) db.prepare("INSERT INTO profile_installations VALUES ('library', ?, 1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=revision+1").run(JSON.stringify(next.openpondProfile ?? null));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    const referenced = new Set(Object.values(definitions).flatMap((account) => account.credential?.source === "secret" ? [account.credential.id] : []));
    for (const account of Object.values(before.accounts ?? {})) if (account.credential?.source === "secret" && !referenced.has(account.credential.id)) await deleteCredential(home, account.credential.id);
    return next;
  });
}
