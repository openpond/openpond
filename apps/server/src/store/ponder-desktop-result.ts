import { createHash } from "node:crypto";
import {
  PonderDesktopResultSchema,
  ponderDesktopRequestContent,
  type PonderDesktopResult,
} from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

function hash(result: PonderDesktopResult) {
  return createHash("sha256")
    .update(ponderDesktopRequestContent("POST", "/ponder/desktop/result", result))
    .digest("hex");
}
export function readPonderDesktopResult(
  db: OpenPondSqliteConnection,
  operationId: string,
  turnId: string,
) {
  const row = db.get<{ payload: string; payload_hash: string }>(
    "SELECT payload, payload_hash FROM ponder_desktop_results WHERE operation_id = ? AND turn_id = ?",
    [operationId, turnId],
  );
  if (!row) return null;
  const result = PonderDesktopResultSchema.parse(JSON.parse(row.payload));
  if (
    result.operationId !== operationId ||
    result.turnId !== turnId ||
    hash(result) !== row.payload_hash
  ) {
    throw new Error("ponder_desktop_committed_result_invalid");
  }
  return result;
}

/** First canonical terminal capture wins. Later projection changes cannot rewrite a returned result. */
export function commitPonderDesktopResult(
  db: OpenPondSqliteConnection,
  value: PonderDesktopResult,
) {
  const result = PonderDesktopResultSchema.parse(value);
  const previous = readPonderDesktopResult(db, result.operationId, result.turnId);
  if (previous) return previous;
  db.run(
    "INSERT INTO ponder_desktop_results (operation_id, turn_id, payload_hash, payload) VALUES (?, ?, ?, ?)",
    [result.operationId, result.turnId, hash(result), JSON.stringify(result)],
  );
  return result;
}
