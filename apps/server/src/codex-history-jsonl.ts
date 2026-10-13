import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseJson, type CodexRecord } from "./codex-history-utils.js";

export async function readJsonlRecords(
  filePath: string,
  onRecord: (record: CodexRecord) => void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const record = parseJson(line);
    if (record) onRecord(record);
  }
}
