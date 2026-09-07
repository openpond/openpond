import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sqlWasmBinary } from "./sql-wasm-binary.js";
import { assertSqlExecutionRequest, type SqlExecutionResult, type SqlValue } from "./sql-execution-contract.js";

type Sqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;
class SqlQueryRejectedError extends Error {}
const functions = new Set([
  "abs", "avg", "char", "coalesce", "concat", "concat_ws", "count", "format", "glob", "group_concat", "hex", "if", "ifnull", "iif", "instr", "length", "like", "likelihood", "likely", "lower", "ltrim", "max", "min", "nullif", "octet_length", "printf", "quote", "replace", "round", "rtrim", "sign", "string_agg", "substr", "substring", "sum", "total", "trim", "typeof", "unhex", "unicode", "unlikely", "upper", "zeroblob",
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
  "json", "json_array", "json_array_length", "json_error_position", "json_extract", "json_group_array", "json_group_object", "json_insert", "json_object", "json_patch", "json_quote", "json_remove", "json_replace", "json_set", "json_type", "json_valid", "->", "->>",
]);
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const decode = (value: SqlValue): null | string | number | bigint | Uint8Array => typeof value !== "object" || value === null ? value : "integer" in value ? BigInt(value.integer) : Buffer.from(value.blobBase64, "base64");
function encode(value: unknown): SqlValue {
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : { integer: value.toString() };
  if (value instanceof Uint8Array) return { blobBase64: Buffer.from(value).toString("base64") };
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new SqlQueryRejectedError("sql_result_unsupported_value");
}

/** Internal child entry only: synchronous SQLite never runs in the application owner. */
export async function executeSqlInChild(raw: unknown): Promise<SqlExecutionResult> {
  const input = assertSqlExecutionRequest(raw);
  // The upstream runtime accepts Emscripten options; its declaration omits them.
  const initialize = sqlite3InitModule as unknown as (options: { wasmBinary: Uint8Array; wasmMemory: WebAssembly.Memory; print: () => void; printErr: () => void }) => Promise<Sqlite>;
  const sqlite = await initialize({ wasmBinary: sqlWasmBinary, wasmMemory: new WebAssembly.Memory({ initial: 128, maximum: 512 }), print: () => {}, printErr: () => {} });
  const { capi } = sqlite;
  const db = new sqlite.oo1.DB(":memory:", "c");
  try {
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;");
    for (const table of input.snapshot.tables) {
      db.exec(`CREATE TABLE ${quoteIdentifier(table.name)} (${table.columns.map(column => `${quoteIdentifier(column.name)} ${column.type}`).join(",")})`);
      const statement = db.prepare(`INSERT INTO ${quoteIdentifier(table.name)} VALUES (${table.columns.map(() => "?").join(",")})`);
      try { for (const row of table.rows) { statement.bind(row.map(decode)); statement.step(); statement.reset(true); } }
      finally { statement.finalize(); }
    }
    db.exec("PRAGMA query_only=ON");
    for (const [id, limit] of [[capi.SQLITE_LIMIT_LENGTH, 1_048_576], [capi.SQLITE_LIMIT_SQL_LENGTH, 65_536], [capi.SQLITE_LIMIT_COLUMN, 128], [capi.SQLITE_LIMIT_EXPR_DEPTH, 100], [capi.SQLITE_LIMIT_COMPOUND_SELECT, 50], [capi.SQLITE_LIMIT_VDBE_OP, 100_000], [capi.SQLITE_LIMIT_ATTACHED, 0], [capi.SQLITE_LIMIT_WORKER_THREADS, 0]] as const) capi.sqlite3_limit(db.pointer!, id, limit);
    const tables = new Set(input.snapshot.tables.map(table => table.name.toLowerCase()));
    const rc = capi.sqlite3_set_authorizer(db.pointer!, (_, action, first, second, database) => {
      if (action === capi.SQLITE_SELECT || action === capi.SQLITE_RECURSIVE) return capi.SQLITE_OK;
      // SQLite's count(*) optimization reports a null database and empty column.
      if (action === capi.SQLITE_READ && (database === "main" || (database === 0 && second === "")) && typeof first === "string" && tables.has(first.toLowerCase())) return capi.SQLITE_OK;
      if (action === capi.SQLITE_FUNCTION && typeof second === "string" && functions.has(second.toLowerCase())) return capi.SQLITE_OK;
      return capi.SQLITE_DENY;
    }, 0);
    if (rc !== capi.SQLITE_OK) throw new Error("sql_authorizer_install_failed");
    try {
      const count = countStatements(sqlite, db.pointer!, input.sql);
      if (count > 1) return { status: "rejected", code: "multiple_statements" };
      if (count !== 1) return { status: "rejected", code: "invalid_query" };
      const statement = db.prepare(input.sql);
      try {
        if (!statement.columnCount || statement.parameterCount) return { status: "rejected", code: "invalid_query" };
        const columns = statement.getColumnNames();
        const rows: SqlValue[][] = [];
        let bytes = Buffer.byteLength(JSON.stringify({ status: "completed", columns, rows }));
        if (bytes > input.maxResultBytes) return { status: "rejected", code: "result_too_large" };
        while (statement.step()) {
          if (rows.length >= input.maxRows) return { status: "rejected", code: "result_too_large" };
          const row = statement.get([]).map(encode);
          bytes += Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
          if (bytes > input.maxResultBytes) return { status: "rejected", code: "result_too_large" };
          rows.push(row);
        }
        return { status: "completed", columns, rows };
      } finally { statement.finalize(); }
    } catch (error) {
      const code = error && typeof error === "object" && "resultCode" in error ? error.resultCode : undefined;
      if (typeof code !== "number" && !(error instanceof SqlQueryRejectedError)) throw error;
      return { status: "rejected", code: code === capi.SQLITE_NOMEM ? "memory_limit" : code === capi.SQLITE_TOOBIG ? "result_too_large" : "invalid_query" };
    }
  } finally { db.close(); }
}

function countStatements(sqlite: Sqlite, db: number, sql: string): number {
  const { wasm, capi } = sqlite;
  const scope = wasm.scopedAllocPush();
  try {
    const [start, bytes] = wasm.scopedAllocCString(sql, true);
    const [statementOut, tailOut] = wasm.scopedAllocPtr(2);
    let cursor = start, count = 0;
    while (cursor < start + bytes) {
      wasm.pokePtr(statementOut!, 0);
      wasm.pokePtr(tailOut!, 0);
      const rc = capi.sqlite3_prepare_v3(db, cursor, start + bytes - cursor, 0, statementOut!, tailOut!);
      const statement = wasm.peekPtr(statementOut!);
      try {
        if (rc !== capi.SQLITE_OK) throw Object.assign(new Error("sql_prepare_failed"), { resultCode: rc });
        if (statement && ++count > 1) return count;
      } finally { if (statement) capi.sqlite3_finalize(statement); }
      const tail = wasm.peekPtr(tailOut!);
      if (tail <= cursor) throw new Error("sql_parser_did_not_advance");
      cursor = tail;
    }
    return count;
  } finally { wasm.scopedAllocPop(scope); }
}
