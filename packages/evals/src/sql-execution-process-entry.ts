import { executeSqlInChild } from "./sql-execution-engine.js";
const input = (globalThis as unknown as { __openpondSqlInput: unknown }).__openpondSqlInput;
void executeSqlInChild(input).then(
  result => process.stdout.write(JSON.stringify({ ok: true, result })),
  () => process.stdout.write(JSON.stringify({ ok: false, error: "sql_environment_failed" })),
);
