import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  MigrationResolutionsSchema, resolveOpenPondHome, storagePaths, initializeHome, recoverMigration, readConfig, patchConfig,
  configEditorSchema, validateConfigText, replaceConfigText, configRecoveryRevisions, restoreConfigRevision,
  readOptionalFile, fileRevision, persistenceIssue, clearCache, resolveEffectiveConfig, setProjectTrust, restartMigration, exportRecoveryBackup, restoreRecoveryBackup, exportSettings, atomicWriteFile, collectArtifactOrphans,
} from "@openpond/persistence";
import { CliUsageError } from "./common/args";

type Options = Record<string, string | boolean>;
const stringOption = (options: Options, name: string): string | undefined => typeof options[name] === "string" ? options[name] as string : undefined;
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function keyPath(options: Options, fallback?: string): string[] {
  const explicit = stringOption(options, "keyPath");
  if (explicit) {
    const parts = JSON.parse(explicit) as unknown;
    if (Array.isArray(parts) && parts.length && parts.every((part) => typeof part === "string" && part.length)) return parts;
    throw new CliUsageError("--key-path must be a JSON array of key segments.");
  }
  if (!fallback) throw new CliUsageError("Specify a setting key, or --key-path for keys containing dots.");
  return fallback.split(".");
}
export async function runConfigurationCommand(options: Options, rest: string[]): Promise<void> {
  const home = resolveOpenPondHome({ home: stringOption(options, "home") });
  const command = rest[0] ?? "get";
  const file = storagePaths(home).config;
  if (command === "path") { console.log(file); return; }
  if (command === "export") {
    const value = await exportSettings(home), destination = stringOption(options, "file");
    if (destination) { await atomicWriteFile(path.resolve(destination), JSON.stringify(value, null, 2), { privateParent: false }); print({ path: path.resolve(destination), requiresRebinding: value.requiresRebinding }); }
    else print(value);
    return;
  }
  if (command === "backup" || command === "restore") {
    const file = stringOption(options, "file"), keyFile = stringOption(options, "keyFile");
    if (!file || !keyFile) throw new CliUsageError(`config ${command} requires --file <encrypted-backup> and --key-file <separate-32-byte-key-file>.`);
    const bytes = await readFile(keyFile);
    const key = bytes.length === 32 ? bytes : Buffer.from(bytes.toString("utf8").trim(), "base64");
    try { print(command === "backup" ? await exportRecoveryBackup(home, file, key) : await restoreRecoveryBackup(file, home, key)); }
    finally { key.fill(0); bytes.fill(0); }
    return;
  }
  if (command === "collect-orphans") { print(await collectArtifactOrphans(home)); return; }
  if (command === "schema") { print(configEditorSchema()); return; }
  if (command === "migrate") {
    const resolutionFile = stringOption(options, "resolutionFile");
    const resolutions = resolutionFile ? MigrationResolutionsSchema.parse(JSON.parse(await readFile(resolutionFile, "utf8"))) : undefined;
    print(await initializeHome(home, { resolutions, sourceAppHome: stringOption(options, "sourceAppHome"), sourceConfig: stringOption(options, "sourceConfig"), sourceBrowserState: stringOption(options, "sourceBrowserState"), dryRun: options.dryRun === true || options.dryRun === "true" })); return;
  }
  if (command === "recover") {
    const revision = stringOption(options, "revision");
    if (revision) print(await restoreConfigRevision(home, revision, stringOption(options, "expectedRevision") ?? fileRevision(await readOptionalFile(file))));
    else print(await recoverMigration(home));
    return;
  }
  if (command === "restart-migration") { print(await restartMigration(home)); return; }
  if (command === "effective") { print(await resolveEffectiveConfig(home, { projectRoot: stringOption(options, "projectRoot"), accountId: stringOption(options, "accountId") })); return; }
  if (command === "trust" || command === "untrust") {
    const root = stringOption(options, "projectRoot") ?? rest[1];
    if (!root) throw new CliUsageError("Specify the canonical project root with --project-root.");
    await setProjectTrust(home, root, stringOption(options, "accountId") ?? "local", command === "trust");
    print({ root, trusted: command === "trust" }); return;
  }
  if (command === "revisions") { print(await configRecoveryRevisions(home)); return; }
  if (command === "validate") {
    const inputFile = stringOption(options, "file") ?? file;
    validateConfigText(await readFile(inputFile, "utf8"), inputFile, options.project === true || options.project === "true" ? "project" : "user");
    print({ valid: true, path: inputFile }); return;
  }
  if (command === "replace") {
    const source = stringOption(options, "file");
    if (!source) throw new CliUsageError("config replace requires --file <validated-toml-file>.");
    print(await replaceConfigText(home, stringOption(options, "expectedRevision") ?? fileRevision(await readOptionalFile(file)), await readFile(source, "utf8"))); return;
  }
  if (command === "doctor") {
    const text = await readOptionalFile(file);
    let issue: unknown = null;
    try { await readConfig(home); } catch (error) { issue = persistenceIssue(error, file); }
    print({ home, path: file, rawRevision: fileRevision(text), issue, recoverableRevisions: await configRecoveryRevisions(home), migration: await readOptionalFile(path.join(storagePaths(home).runtime, "migration.json")) !== null });
    if (issue) process.exitCode = 1;
    return;
  }
  await initializeHome(home);
  if (command === "clear-cache") { clearCache(home); print({ cleared: true, path: storagePaths(home).cache }); return; }
  const snapshot = await readConfig(home);
  if (command === "get") {
    if (!rest[1] && !options.keyPath) { print(snapshot); return; }
    let value: unknown = snapshot.document;
    for (const key of keyPath(options, rest[1])) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    print(value ?? null); return;
  }
  if (command === "set" || command === "unset") {
    const at = keyPath(options, rest[1]);
    let value: unknown;
    if (command === "set") {
      const raw = stringOption(options, "value") ?? rest[2];
      if (raw === undefined) throw new CliUsageError("config set requires a value. Use JSON for arrays, tables, numbers and booleans.");
      try { value = JSON.parse(raw); } catch { value = raw; }
    }
    print(await patchConfig(home, stringOption(options, "expectedRevision") ?? snapshot.rawRevision,
      [command === "set" ? { op: "set", path: at, value } : { op: "unset", path: at }])); return;
  }
  throw new CliUsageError(`Unknown config command: ${command}`);
}
