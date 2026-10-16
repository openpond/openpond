import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  asRecord,
  stringValue,
  numberValue,
  isoFromEpochSeconds,
  millisFromIso,
  normalizeTitleText,
  isoTimestamp,
  stringMap,
} from "./codex-history-utils.js";
import { readJsonlRecords } from "./codex-history-jsonl.js";

export type CodexHistoryIndexEntry = {
  id: string;
  threadName: string | null;
  updatedAt: string | null;
};

export type CodexHistoryPromptEntry = {
  firstPrompt: string | null;
  latestPrompt: string | null;
  firstAt: string | null;
  latestAt: string | null;
};

function cachedFileReader<T>(read: (file: string) => Promise<T>, validateContent=false) {
  const cache = new Map<string, { signature: string; value: Promise<T> }>();
  async function signature(file: string) {
    const stat = await fs.stat(file);
    // Small mutable indexes can be rewritten with identical size/timestamps on
    // coarse filesystems. Content validation keeps native child titles/parents fresh.
    const content=validateContent?createHash("sha256").update(await fs.readFile(file)).digest("hex"):"";
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${content}`;
  }
  return async (file: string): Promise<T> => {
    let version: string;
    try {
      version = await signature(file);
    } catch {
      cache.delete(file);
      return read(file);
    }
    const cached = cache.get(file);
    if (cached?.signature === version) return cached.value;
    const value = read(file)
      .then(async (result) => {
        if (
          (await signature(file).catch(() => null)) !== version &&
          cache.get(file)?.value === value
        )
          cache.delete(file);
        return result;
      })
      .catch((error) => {
        if (cache.get(file)?.value === value) cache.delete(file);
        throw error;
      });
    cache.set(file, { signature: version, value });
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return value;
  };
}
const prompts = cachedFileReader(parsePromptHistory);
const index = cachedFileReader(parseSessionIndex,true);
const globalState = cachedFileReader(parseGlobalState,true);
export const readPromptHistory = (home: string) => prompts(path.join(home, "history.jsonl"));
export const readSessionIndex = (home: string) => index(path.join(home, "session_index.jsonl"));
export const readGlobalState = (home: string) =>
  globalState(path.join(home, ".codex-global-state.json"));

async function parsePromptHistory(filePath: string): Promise<Map<string, CodexHistoryPromptEntry>> {
  const entries = new Map<string, CodexHistoryPromptEntry>();
  await readJsonlRecords(filePath, (record) => {
    const payload = asRecord(record);
    const threadId = stringValue(payload?.session_id);
    const rawText = stringValue(payload?.text) ?? "";
    const timestamp = isoFromEpochSeconds(numberValue(payload?.ts));
    if (!threadId || !/\S/.test(rawText) || !timestamp) return;
    const current = entries.get(threadId) ?? {
      firstPrompt: null,
      latestPrompt: null,
      firstAt: null,
      latestAt: null,
    };
    if (!current.firstAt || millisFromIso(timestamp) < millisFromIso(current.firstAt)) {
      current.firstAt = timestamp;
      current.firstPrompt = normalizeTitleText(rawText).slice(0, 160);
    }
    if (!current.latestAt || millisFromIso(timestamp) > millisFromIso(current.latestAt)) {
      current.latestAt = timestamp;
    }
    entries.set(threadId, current);
  }).catch(() => undefined);
  return entries;
}

async function parseSessionIndex(filePath: string): Promise<Map<string, CodexHistoryIndexEntry>> {
  const entries = new Map<string, CodexHistoryIndexEntry>();
  await readJsonlRecords(filePath, (record) => {
    const payload = asRecord(record);
    const id = stringValue(payload?.id);
    if (!id) return;
    entries.set(id, {
      id,
      threadName: normalizeTitleText(stringValue(payload?.thread_name) ?? "") || null,
      updatedAt: isoTimestamp(stringValue(payload?.updated_at)),
    });
  }).catch(() => undefined);
  return entries;
}

async function parseGlobalState(filePath: string): Promise<{
  workspaceRootHints: Map<string, string>;
}> {
  let payload: unknown;
  try {
    payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    payload = null;
  }
  const state = asRecord(payload);
  return {
    workspaceRootHints: stringMap(asRecord(state?.["thread-workspace-root-hints"])),
  };
}
