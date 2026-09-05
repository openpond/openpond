import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openStorageDatabase, withLocalDatabase } from "./database.js";
import { privateDirectory, atomicWriteFile, withFileLock } from "./private-file.js";
import { storagePaths } from "./home.js";
import { PersistenceError, isMissing } from "./errors.js";
import { digestFile } from "./file-integrity.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({ schemaVersion: z.literal("openpond.artifact.v1"), sha256: hashSchema, sizeBytes: z.number().int().nonnegative().safe(), createdAt: z.string().datetime() });
export type ArtifactOwner = { domain: "chat_attachment" | "dataset" | "taskset" | "harness_release" | "export"; id: string };
export type ArtifactReference = { owner: ArtifactOwner; sha256: string; sizeBytes: number; displayName: string; mediaType: string; createdAt: string };
const SQL = `CREATE TABLE IF NOT EXISTS managed_artifact_objects (sha256 TEXT PRIMARY KEY, payload TEXT NOT NULL, orphaned_at TEXT);
CREATE TABLE IF NOT EXISTS managed_artifact_references (domain TEXT NOT NULL, owner_id TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES managed_artifact_objects(sha256), payload TEXT NOT NULL, PRIMARY KEY(domain,owner_id));
CREATE TABLE IF NOT EXISTS managed_artifact_pins (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL REFERENCES managed_artifact_objects(sha256), owner_pid INTEGER NOT NULL, created_at TEXT NOT NULL);`;
const artifactPath = (home: string, hash: string) => path.join(home, "artifacts", "objects", hashSchema.parse(hash).slice(0, 2), hash);
const lockPath = (home: string) => path.join(storagePaths(home).runtime, "artifacts");
function database<T>(home: string, action: Parameters<typeof withLocalDatabase<T>>[1]): T { return withLocalDatabase(home, (db) => { db.exec(SQL); return action(db); }); }
function invalid(file: string): PersistenceError { return new PersistenceError({ code: "ARTIFACT_UNAVAILABLE", path: file, message: "A referenced artifact is missing or failed its checksum.", action: "Restore the object from a verified backup. Its reference has been preserved." }); }

/** Recovery must establish that every durable reference has complete, authentic bytes. */
export async function validateManagedArtifacts(home: string): Promise<void> {
  const db = openStorageDatabase(storagePaths(home).database, true);
  let rows: { sha256: string; payload: string }[];
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='managed_artifact_references'").get()) return;
    rows = db.prepare("SELECT DISTINCT o.sha256,o.payload FROM managed_artifact_objects o JOIN managed_artifact_references r ON r.sha256=o.sha256").all() as typeof rows;
  } finally { db.close(); }
  for (const row of rows) {
    const file = artifactPath(home, row.sha256);
    try {
      const record = manifestSchema.parse(JSON.parse(row.payload));
      const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(`${file}.json`, "utf8")));
      const stat = await fs.lstat(file);
      if (!stat.isFile() || record.sha256 !== row.sha256 || JSON.stringify(record) !== JSON.stringify(manifest) || stat.size !== record.sizeBytes || await digestFile(file) !== row.sha256) throw invalid(file);
    } catch { throw invalid(file); }
  }
}

/** Bytes and immutable manifest are durable before their authoritative reference commits. */
export async function publishManagedArtifact(home: string, input: { owner: ArtifactOwner; displayName: string; mediaType: string } & ({ bytes: Uint8Array } | { sourceFile: string })): Promise<ArtifactReference & { path: string }> {
  if (!input.owner.id || input.owner.id.length > 4096 || /[\u0000-\u001f]/.test(input.displayName)) throw new Error("Invalid artifact identity or display name.");
  return withFileLock(lockPath(home), async () => {
    const staging = path.join(home, "artifacts", ".staging");
    await privateDirectory(staging);
    const temporary = path.join(staging, randomUUID());
    try {
      if ("bytes" in input) await atomicWriteFile(temporary, input.bytes);
      else {
        if (!(await fs.lstat(input.sourceFile)).isFile()) throw invalid(input.sourceFile);
        await fs.copyFile(input.sourceFile, temporary, fs.constants.COPYFILE_EXCL);
        const handle = await fs.open(temporary, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      const sha256 = await digestFile(temporary), sizeBytes = (await fs.stat(temporary)).size;
      const objectPath = artifactPath(home, sha256), manifestPath = `${objectPath}.json`;
      const createdAt = new Date().toISOString();
      await privateDirectory(path.dirname(objectPath));
      const exists = await fs.lstat(objectPath).catch((error) => { if (isMissing(error)) return null; throw error; });
      if (exists) { if (!exists.isFile() || await digestFile(objectPath) !== sha256) throw invalid(objectPath); }
      else {
        if (process.platform !== "win32") await fs.chmod(temporary, 0o400);
        await fs.rename(temporary, objectPath);
      }
      let manifest: z.infer<typeof manifestSchema>;
      try { manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8"))); }
      catch (error) {
        if (!isMissing(error)) throw invalid(manifestPath);
        manifest = { schemaVersion: "openpond.artifact.v1", sha256, sizeBytes, createdAt };
        await atomicWriteFile(manifestPath, JSON.stringify(manifest));
      }
      if (manifest.sha256 !== sha256 || manifest.sizeBytes !== sizeBytes) throw invalid(manifestPath);
      const reference: ArtifactReference = { owner: input.owner, sha256, sizeBytes, displayName: input.displayName, mediaType: input.mediaType, createdAt };
      database(home, (db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = db.prepare("SELECT sha256 FROM managed_artifact_references WHERE domain=? AND owner_id=?").get(input.owner.domain, input.owner.id) as { sha256: string } | undefined;
          if (existing && existing.sha256 !== sha256) throw new PersistenceError({ code: "IMMUTABLE_ARTIFACT_CONFLICT", path: input.owner.id, message: "This artifact identity already refers to different bytes.", action: "Create a new artifact revision instead of replacing immutable content." });
          db.prepare("INSERT INTO managed_artifact_objects VALUES (?, ?, NULL) ON CONFLICT(sha256) DO UPDATE SET orphaned_at=NULL").run(sha256, JSON.stringify(manifest));
          db.prepare("INSERT INTO managed_artifact_references VALUES (?, ?, ?, ?) ON CONFLICT(domain,owner_id) DO NOTHING").run(input.owner.domain, input.owner.id, sha256, JSON.stringify(reference));
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
      return { ...reference, path: objectPath };
    } finally { await fs.rm(temporary, { force: true }); }
  });
}
export function artifactReference(home: string, owner: ArtifactOwner): ArtifactReference | null {
  return database(home, (db) => {
    const row = db.prepare("SELECT payload FROM managed_artifact_references WHERE domain=? AND owner_id=?").get(owner.domain, owner.id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ArtifactReference : null;
  });
}
export async function withManagedArtifact<T>(home: string, owner: ArtifactOwner, read: (file: string, reference: ArtifactReference) => Promise<T>): Promise<T> {
  const pin = randomUUID();
  const reference = await withFileLock(lockPath(home), async () => {
    const reference = artifactReference(home, owner);
    if (!reference) throw invalid(owner.id);
    database(home, (db) => { db.prepare("INSERT INTO managed_artifact_pins VALUES (?, ?, ?, ?)").run(pin, reference.sha256, process.pid, new Date().toISOString()); });
    return reference;
  });
  try {
    const file = artifactPath(home, reference.sha256), stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size !== reference.sizeBytes || await digestFile(file) !== reference.sha256) throw invalid(file);
    return await read(file, reference);
  } finally { database(home, (db) => { db.prepare("DELETE FROM managed_artifact_pins WHERE id=?").run(pin); }); }
}
export async function releaseArtifactReference(home: string, owner: ArtifactOwner): Promise<void> {
  await withFileLock(lockPath(home), async () => { database(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM managed_artifact_references WHERE domain=? AND owner_id=?").run(owner.domain, owner.id);
      db.prepare("UPDATE managed_artifact_objects SET orphaned_at=coalesce(orphaned_at,?) WHERE sha256 NOT IN (SELECT sha256 FROM managed_artifact_references)").run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }); });
}
export async function collectArtifactOrphans(home: string): Promise<{ removed: string[] }> {
  return withFileLock(lockPath(home), async () => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const retained = database(home, (db) => {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw invalid(storagePaths(home).database);
      return new Set((db.prepare("SELECT sha256 FROM managed_artifact_references UNION SELECT sha256 FROM managed_artifact_pins UNION SELECT sha256 FROM managed_artifact_objects WHERE orphaned_at IS NULL OR orphaned_at >= ?").all(new Date(cutoff).toISOString()) as { sha256: string }[]).map((row) => row.sha256));
    });
    const root = path.join(home, "artifacts", "objects"), removed: string[] = [];
    for (const prefix of await fs.readdir(root, { withFileTypes: true }).catch((error) => { if (isMissing(error)) return []; throw error; })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      for (const name of await fs.readdir(path.join(root, prefix.name))) {
        if (!/^[a-f0-9]{64}$/.test(name) || !name.startsWith(prefix.name) || retained.has(name)) continue;
        const file = artifactPath(home, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        await fs.rm(file); await fs.rm(`${file}.json`, { force: true });
        database(home, (db) => { db.prepare("DELETE FROM managed_artifact_objects WHERE sha256=?").run(name); });
        removed.push(name);
      }
    }
    return { removed };
  });
}
