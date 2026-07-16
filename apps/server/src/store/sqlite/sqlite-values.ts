import type { SQLInputValue, SQLOutputValue } from "node:sqlite";

export function normalizeSqliteParameters(
  params: readonly unknown[] = [],
): SQLInputValue[] {
  return params.map(normalizeSqliteParameter);
}

export function normalizeSqliteRows<T>(
  rows: Record<string, SQLOutputValue>[],
): T[] {
  return rows.map((row) => normalizeSqliteRow<T>(row));
}

export function normalizeSqliteRow<T>(
  row: Record<string, SQLOutputValue>,
): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqliteOutput(value)]),
  ) as T;
}

function normalizeSqliteParameter(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
    || ArrayBuffer.isView(value)
  ) {
    return value as SQLInputValue;
  }
  throw new TypeError(`Unsupported SQLite parameter type: ${typeof value}`);
}

function normalizeSqliteOutput(value: SQLOutputValue): SQLOutputValue | Buffer {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
  return value;
}
