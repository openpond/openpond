import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  codexHistorySessionId,
  readCodexHistoryThreadRevision,
} from "../apps/server/src/codex-history";

describe("Codex history thread revisions", () => {
  test("stays stable for unchanged JSONL and changes after an append", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-revision-"));
    try {
      const threadId = "019fd28f-ce8e-7b41-a86b-0cf623dfeef1";
      const sessionDir = path.join(codexHome, "sessions", "2026", "08", "05");
      const filePath = path.join(
        sessionDir,
        `rollout-2026-08-05T00-00-00-${threadId}.jsonl`,
      );
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-08-05T00:00:00.000Z",
          payload: { id: threadId, cwd: "/tmp/project" },
        })}\n`,
      );
      const sessionId = codexHistorySessionId(threadId);

      const first = await readCodexHistoryThreadRevision(sessionId, { codexHome });
      const unchanged = await readCodexHistoryThreadRevision(sessionId, { codexHome });
      await appendFile(
        filePath,
        `${JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-05T00:00:01.000Z",
          payload: { type: "message", role: "user", content: [] },
        })}\n`,
      );
      const appended = await readCodexHistoryThreadRevision(sessionId, { codexHome });

      expect(unchanged.revision).toBe(first.revision);
      expect(appended.revision).not.toBe(first.revision);
      expect(appended.thread.filePath).toBe(filePath);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
