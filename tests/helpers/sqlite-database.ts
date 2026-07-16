import type { OpenPondSqliteConnection } from "../../apps/server/src/store/sqlite/sqlite-driver";
import { openNodeSqliteConnection } from "../../apps/server/src/store/sqlite/sqlite-driver-node";

export function openTestDatabase(filePath: string): OpenPondSqliteConnection {
  return openNodeSqliteConnection(filePath);
}

export async function runTestSql(
  db: OpenPondSqliteConnection,
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  db.run(sql, params);
}

export async function getTestSql<T>(
  db: OpenPondSqliteConnection,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const row = db.get<T>(sql, params);
  if (row === null) throw new Error(`SQLite query returned no row: ${sql}`);
  return row;
}

export async function allTestSql<T>(
  db: OpenPondSqliteConnection,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return db.all<T>(sql, params);
}

export async function closeTestDatabase(db: OpenPondSqliteConnection): Promise<void> {
  db.close();
}
