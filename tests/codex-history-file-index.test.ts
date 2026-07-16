import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";

import {
  clearCodexHistoryFileIndex,
  codexHistoryFileIndexStats,
  loadCodexHistoryFileIndex,
} from "../apps/server/src/codex-history-file-index";

const roots: string[] = [];

afterEach(async () => {
  clearCodexHistoryFileIndex();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex history file index", () => {
  for (const fileCount of [1_000, 10_000]) {
    test(`caches and deduplicates a ${fileCount.toLocaleString()}-history fixture`, async () => {
      const codexHome = await historyFixture(fileCount);
      const [first, concurrent] = await Promise.all([
        loadCodexHistoryFileIndex(codexHome),
        loadCodexHistoryFileIndex(codexHome),
      ]);
      expect(first).toHaveLength(fileCount);
      expect(concurrent).toBe(first);
      expect(codexHistoryFileIndexStats(codexHome)).toEqual({ files: fileCount, scans: 1 });

      const cached = await loadCodexHistoryFileIndex(codexHome);
      expect(cached).toBe(first);
      expect(codexHistoryFileIndexStats(codexHome).scans).toBe(1);

      await delay(5);
      await writeFile(path.join(codexHome, "history.jsonl"), '{"session_id":"changed"}\n');
      await loadCodexHistoryFileIndex(codexHome);
      expect(codexHistoryFileIndexStats(codexHome).scans).toBe(2);
    }, 30_000);
  }
});

async function historyFixture(fileCount: number): Promise<string> {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), `openpond-codex-index-${fileCount}-`));
  roots.push(codexHome);
  const pending: Promise<void>[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    const bucket = path.join(codexHome, "sessions", String(Math.floor(index / 1_000)).padStart(2, "0"));
    if (index % 1_000 === 0) await mkdir(bucket, { recursive: true });
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    pending.push(writeFile(path.join(bucket, `rollout-${id}.jsonl`), ""));
    if (pending.length === 250) await drain(pending);
  }
  await drain(pending);
  return codexHome;
}

async function drain(pending: Promise<void>[]): Promise<void> {
  await Promise.all(pending);
  pending.length = 0;
}
