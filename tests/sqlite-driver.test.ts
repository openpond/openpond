import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertSupportedNodeSqliteRuntime,
} from "../apps/server/src/store/sqlite/sqlite-driver";
import { NodeSqliteConnection } from "../apps/server/src/store/sqlite/sqlite-driver-node";

describe("node:sqlite driver", () => {
  test("preserves multi-statement execution, positional bindings, values, and row shape", () => {
    const db = new NodeSqliteConnection(":memory:");
    try {
      db.exec(`
        CREATE TABLE values_test (
          id INTEGER PRIMARY KEY,
          enabled INTEGER NOT NULL,
          optional TEXT,
          payload BLOB NOT NULL
        );
        CREATE INDEX values_test_enabled_idx ON values_test(enabled);
      `);
      db.run(
        "INSERT INTO values_test (id, enabled, optional, payload) VALUES (?, ?, ?, ?)",
        [1, true, undefined, Buffer.from([1, 2, 3])],
      );

      const row = db.get<{
        id: number;
        enabled: number;
        optional: null;
        payload: Buffer;
      }>("SELECT * FROM values_test WHERE id = ?", [1]);
      expect(row).toEqual({
        id: 1,
        enabled: 1,
        optional: null,
        payload: Buffer.from([1, 2, 3]),
      });
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Buffer.isBuffer(row?.payload)).toBe(true);
      expect(db.get("SELECT * FROM values_test WHERE id = ?", [2])).toBeNull();
      expect(db.all("SELECT id FROM values_test")).toEqual([{ id: 1 }]);
    } finally {
      db.close();
    }
  });

  test("preserves busy timeout, foreign keys, and explicit rollback", () => {
    const db = new NodeSqliteConnection(":memory:");
    try {
      expect(db.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({ timeout: 1_000 });
      expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
      db.exec("CREATE TABLE rollback_test (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;");
      db.run("INSERT INTO rollback_test (id) VALUES (?)", [1]);
      db.exec("ROLLBACK");
      expect(db.all("SELECT * FROM rollback_test")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("rejects unsupported values and unsupported Node release lines", () => {
    const db = new NodeSqliteConnection(":memory:");
    try {
      expect(() => db.run("SELECT ?", [{ unsupported: true }])).toThrow(
        "Unsupported SQLite parameter type: object",
      );
    } finally {
      db.close();
    }

    expect(assertSupportedNodeSqliteRuntime("24.18.0")).toEqual({ major: 24, minor: 18, patch: 0 });
    expect(assertSupportedNodeSqliteRuntime("24.99.1")).toEqual({ major: 24, minor: 99, patch: 1 });
    expect(() => assertSupportedNodeSqliteRuntime("22.22.1")).toThrow("requires Node.js 24.18.0");
    expect(() => assertSupportedNodeSqliteRuntime("25.0.0")).toThrow("requires Node.js 24.18.0");
    expect(() => assertSupportedNodeSqliteRuntime("unknown")).toThrow("received unknown");
  });

  test("reopens the same file without changing its user version or data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-node-sqlite-driver-"));
    const filename = path.join(directory, "state.sqlite");
    try {
      const first = new NodeSqliteConnection(filename);
      first.exec("PRAGMA journal_mode = WAL; CREATE TABLE durable (value TEXT NOT NULL); PRAGMA user_version = 17;");
      first.run("INSERT INTO durable (value) VALUES (?)", ["preserved"]);
      first.close();

      const reopened = new NodeSqliteConnection(filename);
      try {
        expect(reopened.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" });
        expect(reopened.get("PRAGMA user_version")).toEqual({ user_version: 17 });
        expect(reopened.all("SELECT value FROM durable")).toEqual([{ value: "preserved" }]);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("opens and updates a WAL-checkpointed database created by sqlite3 5.1.7", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-sqlite3-v5-compat-"));
    const filename = path.join(directory, "state.sqlite");
    try {
      const encoded = await readFile(
        path.join(import.meta.dirname, "fixtures", "sqlite3-v5-compatibility.base64"),
        "utf8",
      );
      await writeFile(filename, Buffer.from(encoded.trim(), "base64"));

      const db = new NodeSqliteConnection(filename);
      try {
        expect(db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" });
        expect(db.get("PRAGMA user_version")).toEqual({ user_version: 7 });
        expect(db.get("SELECT * FROM compatibility_values WHERE id = 1")).toEqual({
          id: 1,
          text_value: "written-by-sqlite3-5.1.7",
          null_value: null,
          blob_value: Buffer.from([0, 1, 2, 254, 255]),
        });
        db.run(
          "INSERT INTO compatibility_values (id, text_value, null_value, blob_value) VALUES (?, ?, ?, ?)",
          [2, "written-by-node-sqlite", null, Buffer.from([9, 8, 7])],
        );
      } finally {
        db.close();
      }

      const reopened = new NodeSqliteConnection(filename);
      try {
        expect(reopened.get("PRAGMA user_version")).toEqual({ user_version: 7 });
        expect(reopened.get("SELECT text_value FROM compatibility_values WHERE id = 2")).toEqual({
          text_value: "written-by-node-sqlite",
        });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
