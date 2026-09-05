import { browserStateSchema } from "./browser-migration.js";
import { rebaseStoragePointers, type StorageMove } from "./storage-rebase.js";
import { publishManagedArtifact } from "./artifacts.js";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile } from "./private-file.js";
import { getLocalRecord, putLocalRecord } from "./database.js";
import { migrationConflict } from "./migration-values.js";
import { snapshotCopy, type MigrationJournal } from "./migration-files.js";

export async function importAdditionalDomains(journal: MigrationJournal): Promise<void> {
  const source = path.join(journal.backup, "app");
  const refiners = path.join(source, "refiners");
  if (existsSync(path.join(refiners, "binding.json"))) {
    const binding = await readJsonFile<Record<string, unknown>>(path.join(refiners, "binding.json"), () => ({}));
    if (binding.schemaVersion !== "openpond.refinerBinding.v1") throw migrationConflict(refiners, "Unsupported Refiner binding schema.");
    putLocalRecord(journal.stage, "refiner_bindings", "active", binding);
    const directory = path.join(refiners, "transitions");
    if (existsSync(directory)) for (const name of await fs.readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const receipt = await readJsonFile<Record<string, unknown>>(path.join(directory, name), () => ({}));
      if (receipt.schemaVersion !== "openpond.refinerTransitionReceipt.v1" || typeof receipt.contentHash !== "string") throw migrationConflict(directory, "Unsupported Refiner transition schema.");
      putLocalRecord(journal.stage, "refiner_transitions", receipt.contentHash, receipt);
    }
    await fs.rm(path.join(journal.stage, "library", "refiners", "binding.json"), { force: true });
    await fs.rm(path.join(journal.stage, "library", "refiners", "transitions"), { recursive: true, force: true });
  }
  const extensions = path.join(journal.backup, "global", "extensions");
  if (existsSync(extensions)) {
    await snapshotCopy(extensions, path.join(journal.stage, "library", "extensions"));
    if (existsSync(path.join(extensions, "registry.json"))) {
    const registry = await readJsonFile<Record<string, unknown>>(path.join(extensions, "registry.json"), () => ({}));
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.extensions)) throw migrationConflict(extensions, "Unsupported extension registry schema.");
    putLocalRecord(journal.stage, "extension_installations", "registry", registry);
    await fs.rm(path.join(journal.stage, "library", "extensions", "registry.json"), { force: true });
    }
  }
  const profiles = path.join(journal.backup, "global", "profiles");
  if (existsSync(profiles)) {
    await snapshotCopy(profiles, path.join(journal.stage, "library", "profiles"));
    const entry = getLocalRecord<Record<string, unknown>>(journal.stage, "profile_installations", "library");
    const oldRoot = journal.sourceConfig ? path.join(path.dirname(journal.sourceConfig), "profiles") : null;
    if (entry && oldRoot) {
      const rebase = (value: Record<string, unknown>): Record<string, unknown> => ({ ...value, ...(typeof value.repoPath === "string" && within(value.repoPath, oldRoot) ? { repoPath: path.join(journal.home, "library", "profiles", path.relative(oldRoot, value.repoPath)) } : {}) });
      const value = rebase(entry.value);
      if (Array.isArray(value.profiles)) value.profiles = value.profiles.map((profile) => rebase(profile as Record<string, unknown>));
      putLocalRecord(journal.stage, "profile_installations", "library", value);
    }
  }
  if (journal.sourceBrowserState) {
    const file = path.join(journal.backup, "browser-sidebar-state.json");
    const parsed = browserStateSchema.safeParse(await readJsonFile<unknown>(file, () => null));
    if (!parsed.success) throw migrationConflict(file, "Unsupported browser tab metadata.");
    const metadata = parsed.data;
    for (const [id, conversation] of Object.entries(metadata.conversations)) putLocalRecord(journal.stage, "browser_tab_state", id, conversation);
  }
  const moves: StorageMove[] = [];
  if (journal.sourceAppHome) {
    for (const name of ["harnesses", "refiners"]) moves.push({ from: path.join(journal.sourceAppHome, name), to: path.join(journal.home, "library", name) });
    moves.push({ from: journal.sourceAppHome, to: journal.home });
  }
  if (journal.sourceConfig) for (const name of ["profiles", "extensions"]) moves.push({ from: path.join(path.dirname(journal.sourceConfig), name), to: path.join(journal.home, "library", name) });
  rebaseStoragePointers(journal.stage, moves);
  const attachments = path.join(journal.stage, "attachments");
  if (existsSync(attachments)) await importAttachments(journal.stage, attachments, []);
}
function within(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
async function importAttachments(home: string, directory: string, parts: string[]): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), segments = [...parts, entry.name];
    if (entry.isDirectory()) await importAttachments(home, file, segments);
    else if (entry.isFile() && segments.length >= 3) {
      const storageName = segments.slice(2).join("/");
      await publishManagedArtifact(home, { owner: { domain: "chat_attachment", id: JSON.stringify([segments[0], segments[1], storageName]) }, displayName: entry.name, mediaType: "application/octet-stream", sourceFile: file });
    } else throw migrationConflict(file, "Attachment storage contains an unsupported file or symbolic link.");
  }
}
