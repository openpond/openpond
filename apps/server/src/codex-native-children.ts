import { promises as fs } from "node:fs";
import type { Session } from "@openpond/contracts";
import { loadCodexHistoryThreads } from "./codex-history.js";
import { loadCodexHistoryFileIndex } from "./codex-history-file-index.js";
import { codexHomePath, asRecord, parseJson, stringValue } from "./codex-history-utils.js";

const PAGE_BYTES = 4 * 1024 * 1024;

/** Follow exact provider child receipts from one selected parent, never scan transcripts globally. */
export async function codexNativeChildren(parent: Session, beforeOffset?: number, codexHome = codexHomePath()) {
  if (parent.provider !== "codex" || !parent.codexThreadId) return { items: [] as Session[], beforeOffset: null };
  const file = (await loadCodexHistoryFileIndex(codexHome)).find(file => file.threadId === parent.codexThreadId);
  if (!file) return { items: [] as Session[], beforeOffset: null };
  const handle = await fs.open(file.filePath, "r");
  let text: string, start: number;
  try {
    const size = (await handle.stat()).size;
    const end = Math.min(beforeOffset ?? size, size);
    start = Math.max(0, end - PAGE_BYTES);
    const buffer = Buffer.alloc(end - start);
    const read = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, read.bytesRead).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) return { items: [] as Session[], beforeOffset: start };
      const afterPartialLine = start + Buffer.byteLength(text.slice(0, newline + 1));
      // Oversized source records may consume a whole page; still advance toward earlier receipts.
      if (afterPartialLine < end) start = afterPartialLine;
      text = text.slice(newline + 1);
    }
  } finally { await handle.close(); }
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    const record = parseJson(line);
    const payload = asRecord(record?.payload);
    const item = asRecord(payload?.item);
    if (record?.type !== "event_msg" || payload?.thread_id !== parent.codexThreadId || item?.type !== "SubAgentActivity") continue;
    const id = stringValue(item.agent_thread_id);
    if (id && id !== parent.codexThreadId) ids.add(id);
  }
  const threads = ids.size ? await loadCodexHistoryThreads({ codexHome, onlyThreadIds: ids, metadataLimit: ids.size }) : [];
  return { items: threads.map(thread => thread.session).filter(child => child.metadata?.nativeParentSessionId === parent.codexThreadId)
    .map(child => ({ ...child, parentSessionId: parent.id })), beforeOffset: start || null };
}
