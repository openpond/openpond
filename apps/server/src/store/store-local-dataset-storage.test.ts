import { expect, test } from "vitest";
import { createTasksetDraft, createTasksetDraftWorkspace } from "openpond-sdk/taskset-drafts";
import { sha256 } from "@openpond/harness";
import type { LocalDatasetRecord } from "@openpond/contracts";
import { NodeSqliteConnection } from "./sqlite/sqlite-driver-node.js";
import { CHAT_RESOURCE_TABLES_SQL } from "./store-chat-resource-schema.js";
import { hydrateLocalDatasetRecord, migrateLocalDatasetStorage, retainLocalDatasetRecord } from "./store-local-dataset-storage.js";

const legacySchema = `
CREATE TABLE local_dataset_workspaces(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE local_dataset_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE local_dataset_operations(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,payload TEXT NOT NULL);`;

function record(revision: number, letter = "a"): LocalDatasetRecord {
  const bytes = Buffer.alloc(64 * 1024, letter);
  const draft = createTasksetDraft({ id: "dataset-test", profileId: "owner", name: "Retained corpus", now: "2026-10-14T12:00:00.000Z" });
  return {
    schemaVersion: "openpond.localDataset.v1", ownerId: "owner", projectId: null, checks: [], packageHash: null, sync: null,
    workspace: createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft: { ...draft, revision },
      files: [{ path: "inputs/source.bin", sizeBytes: bytes.length, contentHash: sha256(bytes), base64: bytes.toString("base64") }] }),
  };
}

// Failure story: ordinary edits/retries must not multiply unchanged file bytes,
// while exact old records remain readable after newer metadata is saved.
test("dataset records share file bytes and immutable receipt snapshots", () => {
  const db = new NodeSqliteConnection(":memory:");
  try {
    db.exec(CHAT_RESOURCE_TABLES_SQL);
    const first = record(1), second = record(2);
    db.exec("BEGIN IMMEDIATE");
    const firstHash = retainLocalDatasetRecord(db, first);
    expect(retainLocalDatasetRecord(db, first)).toBe(firstHash);
    const secondHash = retainLocalDatasetRecord(db, second);
    db.exec("COMMIT");
    expect(db.get<{ count: number; bytes: number }>("SELECT COUNT(*) AS count,SUM(length(bytes)) AS bytes FROM local_dataset_blobs")).toEqual({ count: 1, bytes: 64 * 1024 });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM local_dataset_records")?.count).toBe(2);
    for (const [hash, expected] of [[firstHash, first], [secondHash, second]] as const) {
      const saved = db.get<{ payload: string }>("SELECT payload FROM local_dataset_records WHERE record_hash=?", [hash])!;
      expect(saved.payload.length).toBeLessThan(10_000);
      expect(JSON.parse(saved.payload).workspace.files[0]).not.toHaveProperty("base64");
      expect(hydrateLocalDatasetRecord(db, saved.payload)).toEqual(expected);
    }
    db.run("UPDATE local_dataset_blobs SET bytes=?", [Buffer.from("corrupt")]);
    const saved = db.get<{ payload: string }>("SELECT payload FROM local_dataset_records WHERE record_hash=?", [firstHash])!;
    expect(() => hydrateLocalDatasetRecord(db, saved.payload)).toThrow(/checksum/);
  } finally { db.close(); }
});

// Failure story: migrating existing saves must preserve history, pending sync
// bytes and the original retry response, not silently replace them with latest state.
test("legacy dataset migration preserves every authority and deduplicates pending sync files", () => {
  const db = new NodeSqliteConnection(":memory:");
  try {
    db.exec(legacySchema);
    const first = record(1), second = record(2, "b");
    const current: LocalDatasetRecord = { ...second, packageHash: "c".repeat(64), sync: {
      apiOrigin: "https://example.test", actorId: "actor", teamId: "team", datasetId: "remote", remoteRevision: 1,
      acknowledgedHash: first.workspace.contentHash, remoteHash: null, pendingLocalHash: second.workspace.contentHash,
      paused: false, status: "retry", error: "Reply lost", operationId: "upload", pendingWorkspace: first.workspace,
    } };
    db.run("INSERT INTO local_dataset_workspaces VALUES(?,?,?,?)", ["dataset-test", 2, JSON.stringify(current), second.workspace.draft.updatedAt]);
    for (const value of [first, second]) db.run("INSERT INTO local_dataset_versions VALUES(?,?,?)", ["dataset-test", value.workspace.draft.revision, JSON.stringify(value)]);
    db.run("INSERT INTO local_dataset_operations VALUES(?,?,?)", ["original-retry", "intent", JSON.stringify(first)]);
    db.exec("BEGIN IMMEDIATE");
    expect(migrateLocalDatasetStorage(db)).toBe(true);
    db.exec("COMMIT");
    for (const [query, expected] of [
      ["SELECT r.payload FROM local_dataset_workspaces w JOIN local_dataset_records r USING(record_hash)", current],
      ["SELECT r.payload FROM local_dataset_versions w JOIN local_dataset_records r USING(record_hash) WHERE w.revision=1", first],
      ["SELECT r.payload FROM local_dataset_versions w JOIN local_dataset_records r USING(record_hash) WHERE w.revision=2", second],
      ["SELECT r.payload FROM local_dataset_operations w JOIN local_dataset_records r USING(record_hash)", first],
    ] as const) expect(hydrateLocalDatasetRecord(db, db.get<{ payload: string }>(query)!.payload)).toEqual(expected);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM local_dataset_blobs")?.count).toBe(2);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(migrateLocalDatasetStorage(db)).toBe(false);
  } finally { db.close(); }
});

// Failure story: bad historical bytes must abort the whole migration, preserving
// the original tables rather than leaving half-normalized user data behind.
test("invalid legacy bytes roll back the complete dataset migration", () => {
  const db = new NodeSqliteConnection(":memory:");
  try {
    db.exec(legacySchema);
    const damaged = record(1);
    damaged.workspace.files[0]!.base64 = Buffer.from("not the retained source").toString("base64");
    const original = JSON.stringify(damaged);
    db.run("INSERT INTO local_dataset_workspaces VALUES(?,?,?,?)", ["dataset-test", 1, original, damaged.workspace.draft.updatedAt]);
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateLocalDatasetStorage(db)).toThrow();
    db.exec("ROLLBACK");
    expect(db.get<{ payload: string }>("SELECT payload FROM local_dataset_workspaces")?.payload).toBe(original);
    expect(db.get("SELECT name FROM sqlite_master WHERE name='local_dataset_blobs'")).toBeNull();
  } finally { db.close(); }
});
