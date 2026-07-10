import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

export type CodexHistoryFile = {
  threadId: string;
  filePath: string;
  archived: boolean;
  stats: Stats;
};

type IndexEntry = {
  files: CodexHistoryFile[];
  loadedAt: number;
  signature: string;
  scans: number;
};

const DEFAULT_INDEX_TTL_MS = 30_000;
const indexes = new Map<string, IndexEntry>();
const inFlight = new Map<string, Promise<CodexHistoryFile[]>>();

export async function loadCodexHistoryFileIndex(
  codexHome: string,
  options: { now?: number; ttlMs?: number } = {},
): Promise<CodexHistoryFile[]> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_INDEX_TTL_MS;
  const signature = await indexSignature(codexHome);
  const existing = indexes.get(codexHome);
  if (existing && existing.signature === signature && now - existing.loadedAt < ttlMs) {
    return existing.files;
  }
  const pending = inFlight.get(codexHome);
  if (pending) return pending;
  const operation = scanCodexHistoryFiles(codexHome).then((files) => {
    indexes.set(codexHome, {
      files,
      loadedAt: now,
      signature,
      scans: (existing?.scans ?? 0) + 1,
    });
    return files;
  }).finally(() => {
    if (inFlight.get(codexHome) === operation) inFlight.delete(codexHome);
  });
  inFlight.set(codexHome, operation);
  return operation;
}

export function codexHistoryFileIndexStats(codexHome: string): {
  files: number;
  scans: number;
} {
  const entry = indexes.get(codexHome);
  return { files: entry?.files.length ?? 0, scans: entry?.scans ?? 0 };
}

export function clearCodexHistoryFileIndex(codexHome?: string): void {
  if (codexHome) {
    indexes.delete(codexHome);
    inFlight.delete(codexHome);
  } else {
    indexes.clear();
    inFlight.clear();
  }
}

async function scanCodexHistoryFiles(codexHome: string): Promise<CodexHistoryFile[]> {
  const roots = [
    { root: path.join(codexHome, "sessions"), archived: false },
    { root: path.join(codexHome, "archived_sessions"), archived: true },
  ];
  const files: CodexHistoryFile[] = [];
  for (const root of roots) await walk(root.root, root.archived, files);
  return files;
}

async function walk(root: string, archived: boolean, output: CodexHistoryFile[]): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, archived, output);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const threadId = threadIdFromFileName(entry.name);
    if (!threadId) continue;
    const stats = await fs.stat(entryPath).catch(() => null);
    if (stats) output.push({ threadId, filePath: entryPath, archived, stats });
  }
}

async function indexSignature(codexHome: string): Promise<string> {
  const candidates = [
    "sessions",
    "archived_sessions",
    "history.jsonl",
    "session_index.jsonl",
    ".codex-global-state.json",
  ];
  const parts = await Promise.all(candidates.map(async (relativePath) => {
    const stats = await fs.stat(path.join(codexHome, relativePath)).catch(() => null);
    return `${relativePath}:${stats?.mtimeMs ?? 0}:${stats?.size ?? 0}`;
  }));
  return parts.join("|");
}

function threadIdFromFileName(fileName: string): string | null {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(fileName)?.[1] ?? null;
}
