import { createCipheriv } from "node:crypto";
import { SessionSchema, LocalAgentScheduleSchema, LocalAgentScheduleRunSchema } from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store";
import { reconcileInterruptedScheduledWork } from "../apps/server/src/runtime/scheduled-work-recovery";
import { ownHomeRuntime } from "../apps/server/src/runtime/home-runtime-owner";
import { prepareDesktopBrowserHome } from "../apps/desktop/src/desktop-browser-home";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  initializeHome, readConfig, patchConfig, updatePreferences, readPreferences, clearCache,
  writeCredential, readCredential, storagePaths, getLocalRecord, resolveEffectiveConfig, setProjectTrust,
  assertConfigRunCurrent, deleteCredential, exportRecoveryBackup, restoreRecoveryBackup, exportSettings,
  readCache, writeCache, readAccountConfiguration, recoverMigration, readMigrationJournal,
  publishManagedArtifact, withManagedArtifact, releaseArtifactReference, collectArtifactOrphans,
  resolveStoredPath,
} from "../packages/persistence/src/index";
import { startRecoveryServer } from "../apps/server/src/api/startup-recovery";
import { createOpenPondServer } from "../apps/server/src/index";
import { windowsPowerShellEnvironment } from "../packages/persistence/src/windows-powershell";
import { PersistenceError } from "../packages/persistence/src/errors";
import { writeProviderChatGptSubscriptionCredential, readProviderSecrets, deleteProviderCredential } from "../apps/server/src/openpond/provider-secrets";

const run = promisify(execFile);
describe("persistence data and concurrency boundaries", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "openpond-storage-boundary-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  // Vault custody must not inherit access granted to unrelated machine users.
  test("restricts credential custody to the current OS user", async () => {
    await initializeHome(home);
    await writeCredential(home, "private-owner", { token: "private" });
    if (process.platform === "win32") {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$acl=Get-Acl -LiteralPath $env:OPENPOND_ACL_TEST_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; [pscustomobject]@{Protected=$acl.AreAccessRulesProtected; OtherAllow=@($acl.Access | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value}).Count} | ConvertTo-Json -Compress"],
        { env: windowsPowerShellEnvironment({ OPENPOND_ACL_TEST_PATH: path.dirname(storagePaths(home).key) }) });
      expect(JSON.parse(stdout)).toEqual({ Protected: true, OtherAllow: 0 });
    } else {
      expect((await fs.stat(path.dirname(storagePaths(home).key))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(storagePaths(home).key)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(storagePaths(home).credentials)).mode & 0o777).toBe(0o600);
    }
  }, 30_000);

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

  // A recorded config revision is insufficient if execution still uses a stale model.
  test("executes external model edits on the next turn and preserves history through restart", async () => {
    const calls: { requestId: string | undefined; model: string | null | undefined }[] = [];
    const start = () => createOpenPondServer({ port: 0, storeDir: home, silent: true,
      streamOpenPondHostedChatTurn: async function* (input) {
        calls.push({ requestId: input.requestId, model: input.model });
        yield { type: "text_delta", text: "Configuration applied", raw: {} };
        yield { type: "finish", finishReason: "stop", raw: {} };
      },
    });
    let server = await start();
    async function api(route: string, body?: unknown) {
      const response = await fetch(`${server.url}${route}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, value: await response.json() };
    }
    try {
      const session = (await api("/v1/sessions", { provider: "openpond", experience: "chat", title: "Config restart" })).value;
      await writeFile(storagePaths(home).config, 'schema_version = 1\n[chat]\nmodel = { provider_id = "openpond", model_id = "external-model" }\n');
      const first = await api(`/v1/sessions/${session.id}/turns`, { prompt: "Use the external setting" });
      expect(first.value.status).toBe("completed");
      expect(calls.find((call) => call.requestId?.startsWith(first.value.id))?.model).toBe("external-model");
      expect(getLocalRecord<{ snapshot: { document: unknown } }>(home, "config_run_snapshots", first.value.id)?.value.snapshot.document).toMatchObject({ chat: { model: { model_id: "external-model" } } });
      await writeFile(storagePaths(home).config, 'schema_version = 1\n[chat\n');
      expect((await api(`/v1/sessions/${session.id}/turns`, { prompt: "Must not execute invalid configuration" })).status).toBeGreaterThanOrEqual(400);
      await writeFile(storagePaths(home).config, 'schema_version = 1\n[chat]\nmodel = { provider_id = "openpond", model_id = "next-model" }\n');
      await server.close(); server = await start();
      const second = await api(`/v1/sessions/${session.id}/turns`, { prompt: "Continue after restart" });
      expect(second.value.status).toBe("completed");
      expect(calls.find((call) => call.requestId?.startsWith(second.value.id))?.model).toBe("next-model");
      const store = new SqliteStore(home);
      try {
        const history = await store.snapshot();
        expect(history.turns.filter((turn) => turn.sessionId === session.id).map((turn) => turn.id)).toEqual([first.value.id, second.value.id]);
      } finally { await store.close(); }
    } finally { await server.close(); }
  }, 60_000);

  // A cache reset is safe only if both behavioral defaults and layout survive it.
  test("preserves preference changes across cache deletion and restart", async () => {
    await initializeHome(home);
    await updatePreferences(home, { sidebarWidth: 315, steerActiveResponses: false, defaultChatProvider: "openai", defaultChatModel: "chosen-model" });
    await clearCache(home);
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
    const source = path.join(home, "openpond-app"), timestamp = new Date().toISOString();
    await mkdir(source);
    const oldStore = new SqliteStore(source);
    await oldStore.mutate((data) => { data.sessions.push(SessionSchema.parse({ id: "session-1", provider: "openpond", title: "Saved history", appId: null, appName: null, cwd: source, codexThreadId: null, createdAt: timestamp, updatedAt: timestamp, status: "idle", pinned: true, archived: false, order: 3 })); });
    const schedule = LocalAgentScheduleSchema.parse({ id: "disabled-schedule", localProjectId: "saved-project", localProjectName: "Saved", agentRootPath: path.join(source, "harnesses", "project"), agentName: "saved", scheduleName: "daily", scheduleType: "rate", scheduleExpression: "1 hour", timezone: "UTC", targetAction: "run", enabledByDefault: true, enabled: false, sourceHash: "unchanged-source", manifestHash: null, nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastRunId: null, lastError: null, createdAt: timestamp, updatedAt: timestamp });
    await oldStore.upsertLocalAgentSchedule(schedule); await oldStore.close();
    await fs.rename(storagePaths(source).database, path.join(source, "state.sqlite"));
    await rm(path.join(source, "state"), { recursive: true, force: true });
    const db = new DatabaseSync(path.join(source, "state.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS cache_entries (type TEXT, cache_key TEXT, payload TEXT, updated_at TEXT, error TEXT);");
    const cache = db.prepare("INSERT INTO cache_entries (type,cache_key,payload,updated_at,error) VALUES (?, ?, ?, ?, NULL)");
    cache.run("app_preferences", "global", JSON.stringify({ steerActiveResponses: false, sidebarWidth: 321 }), timestamp);
    cache.run("codex_history.sidebar_preferences", "thread-1", JSON.stringify({ pinned: true }), timestamp);
    cache.run("personalization", "active_template_id", JSON.stringify("file:soul-primary.md"), timestamp);
    cache.run("local.projects", "global", JSON.stringify([{ id: "saved-project", path: path.join(source, "harnesses", "project"), name: "Saved" }]), timestamp);
    db.close();
    await mkdir(path.join(source, "harnesses", "project"), { recursive: true });
    await writeFile(path.join(source, "harnesses", "project", "source.json"), '{"immutable":"source-bytes"}');
    // Attachment import creates immutable objects; installation must handle their read-only mode.
    await mkdir(path.join(source, "attachments", "session-1", "turn-1"), { recursive: true });
    await writeFile(path.join(source, "attachments", "session-1", "turn-1", "kept.txt"), "Preserved attachment");
    await writeFile(path.join(source, "soul-primary.md"), "Selected personality\n");
    await writeFile(path.join(source, "SOUL.md"), "Distinct stale SOUL text\n");
    await writeFile(path.join(source, "personalization.json"), JSON.stringify({ version: 1, activeTemplateId: "default", updatedAt: timestamp }));
    const externalDataset = path.join(tmpdir(), `${path.basename(home)}-offline-dataset`);
    await mkdir(path.join(source, "datasets"));
    await writeFile(path.join(source, "datasets", "settings.json"), JSON.stringify({ schemaVersion: "openpond.datasetStorageSettings.v1", datasetStorePath: externalDataset, updatedAt: timestamp }));
    await writeFile(path.join(source, "providers.json"), JSON.stringify({ version: 1, providers: { openai: { enabled: true, baseUrl: "https://provider.example/v1", defaultModel: "fixture-model", modelOverrides: [], updatedAt: timestamp } } }));
    const oldKey = Buffer.alloc(32, 31), iv = Buffer.alloc(12, 32), cipher = createCipheriv("aes-256-gcm", oldKey, iv);
    const ciphertext = Buffer.concat([cipher.update("preserved-provider-key"), cipher.final()]);
    await writeFile(path.join(source, "provider-secrets.key"), oldKey.toString("base64"));
    await writeFile(path.join(source, "provider-secrets.json"), JSON.stringify({ version: 1, providers: { openai: { source: "local_secret", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"), createdAt: timestamp, updatedAt: timestamp } } }));
    const profileRoot = path.join(home, "profiles", "installed");
    await mkdir(profileRoot, { recursive: true });
    await writeFile(path.join(profileRoot, "openpond.json"), '{"profile":"installed-source"}');
    await writeFile(path.join(home, "config.json"), JSON.stringify({ accounts: [
      { handle: "one", baseUrl: "https://one.example", apiKey: "one-key", session: { token: "one-session" } },
      { handle: "two", baseUrl: "https://two.example", apiKey: "two-key" },
    ], activeProfile: { handle: "two", baseUrl: "https://two.example" },
    openpondProfile: { repoPath: profileRoot, profile: "installed", mode: "local", profiles: [{ source: "local", repositoryId: "same-repository", repoPath: profileRoot, profile: "installed" }] } }));
    const browserFile = path.join(home, "old-browser-sidebar.json");
    const browserState = { activeTabId: "tab-1", tabs: [{ id: "tab-1", url: "https://example.com/saved", title: "Saved browser", faviconUrl: null, lastUpdatedAt: 123 }] };
    await writeFile(browserFile, JSON.stringify({ conversations: { "session-1": browserState } }));
    const report = await initializeHome(home, { sourceBrowserState: browserFile });
    expect(report.status).toBe("verified");
    expect(await withManagedArtifact(home, { domain: "chat_attachment", id: JSON.stringify(["session-1", "turn-1", "kept.txt"]) }, (file) => readFile(file, "utf8"))).toBe("Preserved attachment");
    expect(getLocalRecord(home, "browser_tab_state", "session-1")?.value).toEqual(browserState);
    const accounts = await readAccountConfiguration(home);
    expect(accounts.activeProfile).toMatchObject({ handle: "two", baseUrl: "https://two.example" });
    expect(accounts.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ handle: "one", session: expect.objectContaining({ token: "one-session" }) }), expect.objectContaining({ handle: "two", apiKey: "two-key" })]));
    expect(accounts.openpondProfile).toMatchObject({ repoPath: path.join(home, "library", "profiles", "installed"), profile: "installed", profiles: [{ repositoryId: "same-repository", repoPath: path.join(home, "library", "profiles", "installed") }] });
    expect(await readFile(path.join(home, "library", "profiles", "installed", "openpond.json"), "utf8")).toBe('{"profile":"installed-source"}');
    expect((await readPreferences(home)).preferences).toMatchObject({ steerActiveResponses: false, sidebarWidth: 321 });
    expect(getLocalRecord(home, "codex_sidebar_state", "thread-1")?.value).toEqual({ pinned: true });
    expect(getLocalRecord(home, "saved_local_projects", "saved-project")?.value).toMatchObject({ id: "saved-project", path: path.join(home, "library", "harnesses", "project") });
    const config = (await readConfig(home)).document;
    expect(config.storage?.datasets_dir).toBe(externalDataset);
    expect(config.providers?.openai?.default_model).toBe("fixture-model");
    expect((await readCredential<{ value: string }>(home, "provider:openai"))?.value.value).toBe("preserved-provider-key");
    expect(await readFile(path.join(home, "instructions", "personalities", `${config.personalization!.active!.slice(7)}.md`), "utf8")).toBe("Selected personality");
    const originals = await fs.readdir(path.join(home, "instructions", "imported-originals"));
    expect(await Promise.all(originals.map((name) => readFile(path.join(home, "instructions", "imported-originals", name), "utf8")))).toEqual(expect.arrayContaining(["Selected personality\n", "Distinct stale SOUL text\n"]));
    const migrated = new SqliteStore(home);
    try {
      expect(await migrated.getSession("session-1")).toMatchObject({ title: "Saved history", pinned: true, order: 3, cwd: home });
      expect(await migrated.getLocalAgentSchedule(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null, sourceHash: "unchanged-source", agentRootPath: path.join(home, "library", "harnesses", "project") });
      expect(await migrated.listDueLocalAgentSchedules(timestamp)).toEqual([]);
    } finally { await migrated.close(); }
    expect((await initializeHome(home)).status).toBe("current");
    expect(await readFile(path.join(source, "state.sqlite"))).toBeTruthy();
  });

  // Development upgrades must preserve the previously shared login without importing stable history.
  test("imports shared account custody into the known development home without selecting stable history", async () => {
    const global = path.join(home, ".openpond"), development = path.join(global, "openpond-app-dev");
    await mkdir(development, { recursive: true });
    await mkdir(path.join(global, "openpond-app"));
    const devDb = new DatabaseSync(path.join(development, "state.sqlite"));
    devDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT); INSERT INTO sessions VALUES ('development', '{}')"); devDb.close();
    const stableDb = new DatabaseSync(path.join(global, "openpond-app", "state.sqlite"));
    stableDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT); INSERT INTO sessions VALUES ('stable', '{}')"); stableDb.close();
    await writeFile(path.join(global, "config.json"), JSON.stringify({ accounts: [{ handle: "developer", baseUrl: "https://dev.example", apiKey: "development-key" }] }));
    const machineHome = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      await initializeHome(development);
      expect((await readAccountConfiguration(development)).accounts).toMatchObject([{ handle: "developer", apiKey: "development-key" }]);
      const migrated = new DatabaseSync(storagePaths(development).database, { readOnly: true });
      expect(migrated.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "development" }]); migrated.close();
    } finally { machineHome.mockRestore(); }
  });

  // Existing state without a layout marker must never be overwritten by an unrelated import.
  test("refuses migration into an occupied destination and preserves its database", async () => {
    const store = new SqliteStore(home);
    await store.snapshot(); await store.close();
    const before = await readFile(storagePaths(home).database);
    await writeFile(path.join(home, "providers.json"), JSON.stringify({ version: 1, providers: {} }));
    await expect(initializeHome(home)).rejects.toMatchObject({ issue: { code: "MIGRATION_CONFLICT" } });
    expect(await readFile(storagePaths(home).database)).toEqual(before);
  });

  // A process can die after any durable rename, including before its journal acknowledgement.
  test("recovers interrupted preparation, file installation and completion without reimporting new source bytes", async () => {
    for (const phase of ["prepared", "config.toml", "state.sqlite", "storage.json", "committed"]) {
      const target = path.join(home, phase), source = path.join(target, "openpond-app");
      await mkdir(source, { recursive: true });
      const sourceDb = new DatabaseSync(path.join(source, "state.sqlite"));
      sourceDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT); INSERT INTO sessions VALUES ('kept','{\"title\":\"History\"}');");
      sourceDb.close();
      await writeFile(path.join(target, "config.json"), JSON.stringify({ accounts: [
        { handle: "first", baseUrl: "https://one.example", apiKey: "first-key", session: { token: "first-session" } },
        { handle: "second", baseUrl: "https://two.example", apiKey: "second-key" },
      ], activeProfile: { handle: "second", baseUrl: "https://two.example" } }));
      const rename = fs.rename.bind(fs);
      let interrupted = false;
      const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (interrupted) return;
        const output = String(to);
        const journalPhase = output === path.join(target, "runtime", "migration.json") && ["prepared", "committed"].includes(phase)
          ? JSON.parse(await readFile(output, "utf8")).status === phase : false;
        if (journalPhase || output === (phase === "state.sqlite" ? storagePaths(target).database : path.join(target, phase))) {
          interrupted = true;
          throw new Error("Simulated interruption after durable rename");
        }
      });
      try { await expect(initializeHome(target)).rejects.toBeDefined(); } finally { spy.mockRestore(); }
      expect(interrupted).toBe(true);
      expect(await readMigrationJournal(target)).toBeTruthy();
      await recoverMigration(target);
      expect((await initializeHome(target)).status).toBe("current");
      expect((await readAccountConfiguration(target)).accounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ handle: "first", apiKey: "first-key", session: expect.objectContaining({ token: "first-session" }) }),
        expect.objectContaining({ handle: "second", apiKey: "second-key" }),
      ]));
      const restored = new DatabaseSync(storagePaths(target).database, { readOnly: true });
      expect(restored.prepare("SELECT id FROM sessions").get()?.id).toBe("kept"); restored.close();
      expect((await readMigrationJournal(target))?.status).toBe("verified");
    }
  }, process.platform === "win32" ? 180_000 : 30_000);

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
    const evidencePath = path.join(home, "training", "evidence.json");
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, '{"immutable":"evidence"}');
    const receipt = JSON.stringify({ contentHash: "unchanged-receipt-hash", artifactPath: evidencePath });
    const receiptDb = new DatabaseSync(storagePaths(home).database);
    receiptDb.exec("CREATE TABLE model_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    receiptDb.prepare("INSERT INTO model_runs VALUES ('preserved-run', ?)").run(receipt); receiptDb.close();
    const artifact = await publishManagedArtifact(home, { owner: { domain: "dataset", id: "backup-dataset" }, displayName: "rows.json", mediaType: "application/json", bytes: Buffer.from("[1,2,3]") });
    const output = `${home}-export.opbk`, restored = `${home}-restored`, rejected = `${home}-wrong-key`;
    const key = Buffer.alloc(32, 19);
    try {
      await exportRecoveryBackup(home, output, key);
      expect((await readFile(output)).includes(Buffer.from("backup-secret"))).toBe(false);
      await expect(restoreRecoveryBackup(output, rejected, Buffer.alloc(32, 20))).rejects.toMatchObject({ issue: { code: "RESTORE_FAILED" } });
      await expect(readFile(storagePaths(rejected).marker)).rejects.toMatchObject({ code: "ENOENT" });
      await restoreRecoveryBackup(output, restored, key);
      const restoredDb = new DatabaseSync(storagePaths(restored).database, { readOnly: true });
      expect(restoredDb.prepare("SELECT payload FROM model_runs WHERE id='preserved-run'").get()?.payload).toBe(receipt); restoredDb.close();
      expect(resolveStoredPath(restored, evidencePath)).toBe(path.join(restored, "training", "evidence.json"));
      expect(await readFile(resolveStoredPath(restored, evidencePath), "utf8")).toBe('{"immutable":"evidence"}');
      expect((await readPreferences(restored)).preferences.steerActiveResponses).toBe(false);
      expect(await withManagedArtifact(restored, { domain: "dataset", id: "backup-dataset" }, (file) => readFile(file, "utf8"))).toBe("[1,2,3]");
      await rm(artifact.path);
      await expect(exportRecoveryBackup(home, `${output}-missing`, key)).rejects.toMatchObject({ issue: { code: "ARTIFACT_UNAVAILABLE" } });
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

  // Corrupt disposable data must rebuild without touching behavioral defaults or history.
  test("rebuilds a corrupt cache without replacing authoritative state", async () => {
    await initializeHome(home);
    await updatePreferences(home, { steerActiveResponses: false });
    await writeCache(home, "catalog", "one", { name: "rebuildable" });
    await writeFile(storagePaths(home).cache, "broken sqlite");
    expect(await readCache(home, "catalog", "one")).toBeNull();
    await writeCache(home, "catalog", "one", { name: "fresh" });
    expect((await readCache<{ name: string }>(home, "catalog", "one"))?.payload.name).toBe("fresh");
    expect((await readPreferences(home)).preferences.steerActiveResponses).toBe(false);
  });

  // Two launchers and two SQL writers cannot claim the same scheduled occurrence twice.
  test("retains unique schedule claims and pauses uncertain work after restart", async () => {
    await initializeHome(home);
    const first = new SqliteStore(home);
    await first.recentTurns(1);
    const second = new SqliteStore(home);
    await second.recentTurns(1);
    const timestamp = new Date().toISOString();
    const schedule = LocalAgentScheduleSchema.parse({ id: "schedule-proof", localProjectId: "project-proof", localProjectName: "Proof", agentRootPath: home, agentName: "proof", scheduleName: "daily", scheduleType: "rate", scheduleExpression: "1 hour", timezone: "UTC", targetAction: "run", enabledByDefault: true, enabled: true, sourceHash: "source-proof", manifestHash: null, nextRunAt: timestamp, lastRunAt: null, lastRunStatus: null, lastRunId: null, lastError: null, createdAt: timestamp, updatedAt: timestamp });
    await first.upsertLocalAgentSchedule(schedule);
    const run = LocalAgentScheduleRunSchema.parse({ id: "run-proof", scheduleId: schedule.id, definitionSnapshot: schedule, configurationSnapshot: { schema_version: 1 }, localProjectId: schedule.localProjectId, scheduleName: schedule.scheduleName, scheduledFor: timestamp, trigger: "schedule", status: "running", targetAction: "run", startedAt: timestamp, completedAt: null, exitCode: null, stdout: null, stderr: null, result: null, traceArtifactRef: null, error: null, createdAt: timestamp, updatedAt: timestamp });
    try {
      const claims = await Promise.allSettled([first.insertLocalAgentScheduleRun(run), second.insertLocalAgentScheduleRun({ ...run, id: "duplicate-proof" })]);
      expect(claims.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    } finally { await first.close(); await second.close(); }
    const runtime = await ownHomeRuntime(home, async () => ({ close: async () => {} }));
    try {
      await expect(ownHomeRuntime(home, async () => ({ close: async () => {} }))).rejects.toMatchObject({ issue: { code: "RUNTIME_ALREADY_RUNNING" } });
      expect(reconcileInterruptedScheduledWork(home)).toEqual({ recovered: 0, needsReview: 1 });
      expect(reconcileInterruptedScheduledWork(home)).toEqual({ recovered: 0, needsReview: 0 });
      const restarted = new SqliteStore(home);
      try {
        expect(await restarted.getLocalAgentSchedule(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null, lastRunStatus: "failed" });
        expect(await restarted.listDueLocalAgentSchedules(timestamp)).toEqual([]);
        await expect(restarted.insertLocalAgentScheduleRun({ ...run, id: "after-restart" })).rejects.toThrow();
      } finally { await restarted.close(); }
    } finally { await runtime.close(); }
  });

  // A crash between native profile rename and receipt commit must verify the prepared tree.
  test("recovers a prepared native browser rename and rejects altered profile bytes", async () => {
    const previous = path.join(home, "previous-browser"), targetHome = path.join(home, "new-home");
    await mkdir(previous);
    await writeFile(path.join(previous, "Cookies"), "preserved browser state");
    const profile = prepareDesktopBrowserHome(targetHome, previous);
    const journal = path.join(targetHome, "browser", "native-migration.json");
    const receipt = JSON.parse(await readFile(journal, "utf8"));
    await writeFile(journal, JSON.stringify({ ...receipt, status: "prepared" }));
    prepareDesktopBrowserHome(targetHome, previous);
    expect(JSON.parse(await readFile(journal, "utf8")).status).toBe("committed");
    await writeFile(journal, JSON.stringify({ ...receipt, status: "prepared" }));
    await writeFile(path.join(profile.userData, "Cookies"), "altered before recovery");
    expect(() => prepareDesktopBrowserHome(targetHome, previous)).toThrow("could not be migrated");
    expect(await readFile(path.join(previous, "Cookies"), "utf8")).toBe("preserved browser state");
  });

});
