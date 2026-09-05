import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  initializeHome, readConfig, patchConfig, updatePreferences, readPreferences, clearCache,
  writeCredential, readCredential, storagePaths, getLocalRecord, resolveEffectiveConfig, setProjectTrust,
  assertConfigRunCurrent, deleteCredential, exportRecoveryBackup, restoreRecoveryBackup, exportSettings,
  publishManagedArtifact, withManagedArtifact, releaseArtifactReference, collectArtifactOrphans,
} from "../packages/persistence/src/index";
import { startRecoveryServer } from "../apps/server/src/api/startup-recovery";
import { PersistenceError } from "../packages/persistence/src/errors";
import { writeProviderChatGptSubscriptionCredential, readProviderSecrets, deleteProviderCredential } from "../apps/server/src/openpond/provider-secrets";

const run = promisify(execFile);
describe("persistence data and concurrency boundaries", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "openpond-storage-boundary-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  // Independent CLI processes must not lose each other's settings or accept stale edits.
  test("serializes separate process edits and preserves manual TOML comments", async () => {
    await initializeHome(home);
    const file = storagePaths(home).config;
    await writeFile(file, 'schema_version = 1\n# My editor\n[editor]\ncheck_on_save = true # keep this\n');
    const stale = await readConfig(home);
    const module = new URL("../packages/persistence/dist/index.js", import.meta.url).href;
    await Promise.all([false, true].map((enabled, index) => run(process.execPath, ["--input-type=module", "-e",
      `import { updateConfig } from ${JSON.stringify(module)}; await updateConfig(process.argv[1], value => ({ ...value, ${index ? "ui" : "chat"}: { ${index ? "advanced_workspace_controls" : "steer_active_responses"}: ${enabled} } }));`, home,
    ])));
    expect((await readConfig(home)).document).toMatchObject({ chat: { steer_active_responses: false }, ui: { advanced_workspace_controls: true }, editor: { check_on_save: true } });
    await expect(patchConfig(home, stale.rawRevision, [{ op: "set", path: ["editor", "check_on_save"], value: false }])).rejects.toMatchObject({ issue: { code: "CONFIG_CONFLICT" } });
    const latest = await readConfig(home);
    await patchConfig(home, latest.rawRevision, [{ op: "set", path: ["editor", "check_on_save"], value: false }]);
    expect(await readFile(file, "utf8")).toContain('# My editor\n[editor]\ncheck_on_save = false # keep this');
  });

  // Invalid manual edits must never be silently replaced by normalized defaults.
  test("leaves invalid and protected project configuration untouched", async () => {
    const file = storagePaths(home).config;
    await writeFile(file, 'schema_version = 1\n[permissions]\ncommand_access = "unknown"\n');
    const bytes = await readFile(file);
    await expect(updatePreferences(home, { steerActiveResponses: false })).rejects.toMatchObject({ issue: { code: "INVALID_CONFIG" } });
    expect(await readFile(file)).toEqual(bytes);
    await writeFile(file, 'schema_version = 1\n[permissions]\ncommand_access = "full-access"\n');
    await expect(readConfig(home, { scope: "project" })).rejects.toMatchObject({ issue: { code: "INVALID_CONFIG" } });
  });

  // A cache reset is safe only if both behavioral defaults and layout survive it.
  test("preserves preference changes across cache deletion and restart", async () => {
    await initializeHome(home);
    await updatePreferences(home, { sidebarWidth: 315, steerActiveResponses: false, defaultChatProvider: "openai", defaultChatModel: "chosen-model" });
    clearCache(home);
    await initializeHome(home);
    expect((await readPreferences(home)).preferences).toMatchObject({ sidebarWidth: 315, steerActiveResponses: false, defaultChatModelRef: { providerId: "openai", modelId: "chosen-model" } });
    const text = await readFile(storagePaths(home).config, "utf8");
    expect(text).not.toContain("sidebar");
    expect((await readConfig(home)).document.editor).toBeUndefined();
  });

  // Losing the encryption key must preserve the encrypted evidence and never create a replacement key.
  test("does not replace a missing vault key", async () => {
    await writeCredential(home, "account:one", { token: "private-token" }, null);
    const vault = await readFile(storagePaths(home).credentials);
    await rm(storagePaths(home).key);
    await expect(readCredential(home, "account:one")).rejects.toMatchObject({ issue: { code: "CREDENTIAL_RECOVERY_REQUIRED" } });
    await expect(writeCredential(home, "account:two", { token: "new-token" })).rejects.toMatchObject({ issue: { code: "CREDENTIAL_RECOVERY_REQUIRED" } });
    expect(await readFile(storagePaths(home).credentials)).toEqual(vault);
    await expect(readFile(storagePaths(home).key)).rejects.toMatchObject({ code: "ENOENT" });
    expect(vault.toString()).not.toContain("private-token");
  });

  // A delayed OAuth refresh must not undo logout or overwrite a new login.
  test("rejects an OAuth refresh completed after logout", async () => {
    const paths = { secretsFilePath: storagePaths(home).credentials, keyFilePath: storagePaths(home).key };
    const credential = { refreshToken: "secret-refresh", accessToken: "secret-access", expiresAt: Date.now() + 60_000, accountId: "account-1" };
    await writeProviderChatGptSubscriptionCredential({ paths, providerId: "openai", credential, timestamp: new Date().toISOString() });
    const expected = (await readProviderSecrets(paths)).providers.openai!;
    await deleteProviderCredential({ paths, providerId: "openai", request: {} });
    await expect(writeProviderChatGptSubscriptionCredential({ paths, providerId: "openai", credential, expected, timestamp: new Date().toISOString() })).rejects.toMatchObject({ issue: { code: "CREDENTIAL_CONFLICT" } });
    expect((await readProviderSecrets(paths)).providers.openai).toBeUndefined();
    expect(await readCredential(home, expected.credentialId!)).toBeNull();
  });

  // Migration must preserve durable SQL rows and settings while retaining the original backup.
  test("imports old preferences and retains history and schedule rows without executing them", async () => {
    const source = path.join(home, "openpond-app");
    await mkdir(source);
    const db = new DatabaseSync(path.join(source, "state.sqlite"));
    db.exec("CREATE TABLE cache_entries (type TEXT, cache_key TEXT, payload TEXT, updated_at TEXT, error TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT); CREATE TABLE schedules (id TEXT PRIMARY KEY, payload TEXT);");
    db.prepare("INSERT INTO cache_entries VALUES (?, ?, ?, ?, NULL)").run("app_preferences", "global", JSON.stringify({ steerActiveResponses: false, sidebarWidth: 321 }), new Date().toISOString());
    db.prepare("INSERT INTO cache_entries VALUES (?, ?, ?, ?, NULL)").run("codex_history.sidebar_preferences", "thread-1", JSON.stringify({ pinned: true }), new Date().toISOString());
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("session-1", JSON.stringify({ title: "Saved history", messages: ["keep"] }));
    db.prepare("INSERT INTO schedules VALUES (?, ?)").run("schedule-1", JSON.stringify({ status: "running", externalReceipt: "already-sent" }));
    db.close();
    const report = await initializeHome(home);
    expect(report.status).toBe("verified");
    expect((await readPreferences(home)).preferences).toMatchObject({ steerActiveResponses: false, sidebarWidth: 321 });
    expect(getLocalRecord(home, "codex_sidebar_state", "thread-1")?.value).toEqual({ pinned: true });
    const migrated = new DatabaseSync(storagePaths(home).database, { readOnly: true });
    expect(migrated.prepare("SELECT payload FROM sessions").get()?.payload).toContain("Saved history");
    expect(migrated.prepare("SELECT payload FROM schedules").get()?.payload).toContain("already-sent");
    migrated.close();
    expect((await initializeHome(home)).status).toBe("current");
    expect(await readFile(path.join(source, "state.sqlite"))).toBeTruthy();
  });
  // A trusted project cannot acquire host authority; a captured turn cannot survive revocation.
  test("resolves trusted project values atomically and checks current revocations", async () => {
    await initializeHome(home);
    const repo = path.join(home, "repo");
    await mkdir(path.join(repo, ".openpond"), { recursive: true });
    await writeFile(storagePaths(home).config, 'schema_version = 1\n[chat]\nmodel = { provider_id = "openai", model_id = "host-model" }\n[permissions]\ncommand_access = "disabled"\ncodex_mode = "default"\n');
    const projectFile = path.join(repo, ".openpond", "config.toml");
    await writeFile(projectFile, 'schema_version = 1\n[chat]\nmodel = { provider_id = "anthropic", model_id = "project-model" }\n');
    const context = { projectRoot: repo, accountId: "one", turn: { schema_version: 1 as const, permissions: { command_access: "full-access" as const, codex_mode: "full-access" as const } } };
    const ignored = await resolveEffectiveConfig(home, context);
    expect(ignored.document.chat?.model?.model_id).toBe("host-model");
    expect(ignored.diagnostics).toMatchObject([{ code: "PROJECT_CONFIG_UNTRUSTED" }]);
    await setProjectTrust(home, repo, "one", true);
    const pinned = await resolveEffectiveConfig(home, context);
    expect(pinned.document.chat?.model).toEqual({ provider_id: "anthropic", model_id: "project-model" });
    expect(pinned.document.permissions).toEqual({ command_access: "disabled", codex_mode: "default" });
    await writeFile(projectFile, 'schema_version = 1\n[chat]\nmodel = { provider_id = "openai", model_id = "next-model" }\n');
    await assertConfigRunCurrent(home, pinned, context);
    expect(pinned.document.chat?.model?.model_id).toBe("project-model");
    await setProjectTrust(home, repo, "one", false);
    await expect(assertConfigRunCurrent(home, pinned, context)).rejects.toMatchObject({ issue: { code: "PROJECT_TRUST_CHANGED" } });
    await setProjectTrust(home, repo, "one", true);
    await writeFile(projectFile, 'schema_version = 1\n[providers.openai]\nbase_url = "https://untrusted.example"\n');
    await expect(resolveEffectiveConfig(home, context)).rejects.toMatchObject({ issue: { code: "INVALID_CONFIG" } });
    const config = await readConfig(home);
    await writeCredential(home, "test-provider", { token: "retained-secret" });
    await patchConfig(home, config.rawRevision, [{ op: "set", path: ["providers", "openai"], value: { credential: { source: "secret", id: "test-provider" } } }]);
    const credentialSnapshot = await resolveEffectiveConfig(home);
    expect(JSON.stringify(credentialSnapshot)).not.toContain("retained-secret");
    await deleteCredential(home, "test-provider");
    await expect(assertConfigRunCurrent(home, credentialSnapshot)).rejects.toMatchObject({ issue: { code: "EXECUTION_POLICY_CHANGED" } });
  });

  // Invalid startup must retain a repair path without exposing config to unauthenticated clients.
  test("repairs invalid startup configuration through an authenticated recovery surface", async () => {
    await initializeHome(home);
    await writeFile(storagePaths(home).config, 'schema_version = 1\n[broken');
    const recovery = await startRecoveryServer(home, 0, new PersistenceError({ code: "INVALID_CONFIG", path: storagePaths(home).config, message: "Invalid TOML", action: "Repair config" }));
    try {
      expect((await fetch(`${recovery.url}/v1/recovery`)).status).toBe(401);
      const headers = { Authorization: `Bearer ${recovery.token}`, "Content-Type": "application/json" };
      const response = await fetch(`${recovery.url}/v1/recovery`, { headers });
      const state = await response.json() as { config: { rawRevision: string; issue: { code: string } } };
      expect(state.config.issue.code).toBe("INVALID_CONFIG");
      expect((await fetch(`${recovery.url}/v1/sessions`, { headers })).status).toBe(503);
      const saved = await fetch(`${recovery.url}/v1/configuration`, { headers, method: "POST", body: JSON.stringify({ action: "replace", expectedRevision: state.config.rawRevision, text: 'schema_version = 1\n[chat]\nsteer_active_responses = false\n' }) });
      expect(saved.status).toBe(200);
      expect((await fetch(`${recovery.url}/v1/recovery`, { headers, method: "POST", body: JSON.stringify({ action: "retry" }) })).status).toBe(200);
      await recovery.repaired;
      expect((await readPreferences(home)).preferences.steerActiveResponses).toBe(false);
    } finally { await recovery.close(); }
  });

  // An encrypted backup must recover durable identities and auth, while a wrong key cannot activate files.
  test("restores an authenticated encrypted backup into a fresh home", async () => {
    await initializeHome(home);
    await updatePreferences(home, { steerActiveResponses: false });
    await writeCredential(home, "account:backup", { token: "backup-secret" });
    const output = `${home}-export.opbk`, restored = `${home}-restored`, rejected = `${home}-wrong-key`;
    const key = Buffer.alloc(32, 19);
    try {
      await exportRecoveryBackup(home, output, key);
      expect((await readFile(output)).includes(Buffer.from("backup-secret"))).toBe(false);
      await expect(restoreRecoveryBackup(output, rejected, Buffer.alloc(32, 20))).rejects.toMatchObject({ issue: { code: "RESTORE_FAILED" } });
      await expect(readFile(storagePaths(rejected).marker)).rejects.toMatchObject({ code: "ENOENT" });
      await restoreRecoveryBackup(output, restored, key);
      expect((await readPreferences(restored)).preferences.steerActiveResponses).toBe(false);
      expect((await readCredential<{ token: string }>(restored, "account:backup"))?.value.token).toBe("backup-secret");
      await expect(restoreRecoveryBackup(output, home, key)).rejects.toThrow("fresh, empty home");
      expect(JSON.stringify(await exportSettings(home))).not.toContain("backup-secret");
    } finally { await Promise.all([output, restored, rejected].map((file) => rm(file, { recursive: true, force: true }))); }
  });

  // A deleted reference is collectible only after readers release pins and the grace period expires.
  test("protects in-use immutable objects during orphan collection", async () => {
    await initializeHome(home);
    const owner = { domain: "chat_attachment" as const, id: "attachment-one" };
    const artifact = await publishManagedArtifact(home, { owner, displayName: "notes.txt", mediaType: "text/plain", bytes: Buffer.from("immutable notes") });
    let release!: () => void, reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const read = withManagedArtifact(home, owner, async (file) => { reading(); await held; return readFile(file, "utf8"); });
    await started;
    await releaseArtifactReference(home, owner);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86_400_000);
    try {
      expect((await collectArtifactOrphans(home)).removed).toEqual([]);
      release(); expect(await read).toBe("immutable notes");
      expect((await collectArtifactOrphans(home)).removed).toEqual([artifact.sha256]);
    } finally { release(); await read; clock.mockRestore(); }
  });

});
