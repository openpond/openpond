import { DatabaseSync } from "node:sqlite";

import {
  assertSupportedNodeSqliteRuntime,
  type OpenPondSqliteConnection,
} from "./sqlite-driver.js";
import {
  normalizeSqliteParameters,
  normalizeSqliteRow,
  normalizeSqliteRows,
} from "./sqlite-values.js";

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

export class NodeSqliteConnection implements OpenPondSqliteConnection {
  readonly #database: DatabaseSync;

  constructor(filename: string) {
    assertSupportedNodeSqliteRuntime();
    this.#database = new DatabaseSync(filename, {
      allowBareNamedParameters: true,
      allowUnknownNamedParameters: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readBigInts: false,
      returnArrays: false,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  run(sql: string, params: readonly unknown[] = []): void {
    this.#database.prepare(sql).run(...normalizeSqliteParameters(params));
  }

  all<T>(sql: string, params: readonly unknown[] = []): T[] {
    const rows = this.#database.prepare(sql).all(...normalizeSqliteParameters(params));
    return normalizeSqliteRows<T>(rows);
  }

  get<T>(sql: string, params: readonly unknown[] = []): T | null {
    const row = this.#database.prepare(sql).get(...normalizeSqliteParameters(params));
    return row ? normalizeSqliteRow<T>(row) : null;
  }

  close(): void {
    this.#database.close();
  }
}

export function openNodeSqliteConnection(filename: string): OpenPondSqliteConnection {
  return new NodeSqliteConnection(filename);
}
