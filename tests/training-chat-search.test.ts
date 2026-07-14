import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readCodexHistorySearchText, type CodexHistoryThread } from "../apps/server/src/codex-history";
import { withTrainingStore } from "./helpers/training-fixtures";

describe("training chat full-text search", () => {
  test("extracts user and assistant message text from Codex history files", async () => {
    await withTrainingStore(async ({ directory }) => {
      const filePath = path.join(directory, "codex-history.jsonl");
      await writeFile(filePath, [
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "find the mercury ledger" }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The ledger is reconciled." }] } },
        { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "secret tool noise" } },
      ].map((record) => JSON.stringify(record)).join("\n"));
      const text = await readCodexHistorySearchText({ filePath } as CodexHistoryThread);
      expect(text).toContain("find the mercury ledger");
      expect(text).toContain("The ledger is reconciled.");
      expect(text).not.toContain("secret tool noise");
    });
  });

  test("returns 20-result pages and searches message bodies instead of titles only", async () => {
    await withTrainingStore(async ({ store }) => {
      const documents = Array.from({ length: 45 }, (_, index) => ({
        sessionId: `session_${String(index).padStart(2, "0")}`,
        source: "openpond" as const,
        signature: `signature_${index}`,
        title: `Research conversation ${index}`,
        body: index === 31
          ? "The assistant proposed a cobalt-orchid deployment checklist."
          : `Ordinary conversation body ${index}`,
        updatedAt: new Date(Date.UTC(2026, 6, 13, 0, 0, index)).toISOString(),
        eligible: true,
        bodyIndexed: true,
      }));
      await store.syncTrainingChatSearchDocuments("openpond", documents);
      const candidateIds = documents.map((document) => document.sessionId);

      const first = await store.searchTrainingChats({ query: "", offset: 0, limit: 20, candidateIds });
      expect(first.entries).toHaveLength(20);
      expect(first.total).toBe(45);
      expect(first.hasMore).toBe(true);

      const second = await store.searchTrainingChats({ query: "", offset: 20, limit: 20, candidateIds });
      expect(second.entries).toHaveLength(20);
      expect(second.entries[0]?.sessionId).not.toBe(first.entries[0]?.sessionId);
      expect(second.hasMore).toBe(true);

      const third = await store.searchTrainingChats({ query: "", offset: 40, limit: 20, candidateIds });
      expect(third.entries).toHaveLength(5);
      expect(third.hasMore).toBe(false);

      const contentMatch = await store.searchTrainingChats({ query: "cobalt orchid", offset: 0, limit: 20, candidateIds });
      expect(contentMatch.total).toBe(1);
      expect(contentMatch.entries[0]).toMatchObject({ sessionId: "session_31", title: "Research conversation 31" });
      expect(contentMatch.entries[0]?.snippet).toContain("cobalt-orchid");

      await expect(
        store.searchTrainingChats({ query: '"cobalt" OR (orchid)*', offset: 0, limit: 20, candidateIds }),
      ).resolves.toMatchObject({ total: 1 });
    });
  });

  test("updates changed documents and removes chats no longer supplied by a source", async () => {
    await withTrainingStore(async ({ store }) => {
      await store.syncTrainingChatSearchDocuments("codex", [
        { sessionId: "codex_history_one", source: "codex", signature: "v1", title: "One", body: "old marker", updatedAt: "2026-07-13T00:00:00.000Z", eligible: true, bodyIndexed: true },
        { sessionId: "codex_history_two", source: "codex", signature: "v1", title: "Two", body: "remove marker", updatedAt: "2026-07-13T00:00:01.000Z", eligible: true, bodyIndexed: true },
      ]);
      await store.syncTrainingChatSearchDocuments("codex", [
        { sessionId: "codex_history_one", source: "codex", signature: "v2", title: "Renamed", body: "new marker", updatedAt: "2026-07-13T00:00:02.000Z", eligible: true, bodyIndexed: true },
      ]);
      const candidateIds = ["codex_history_one", "codex_history_two"];

      expect((await store.searchTrainingChats({ query: "old", offset: 0, limit: 20, candidateIds })).total).toBe(0);
      expect((await store.searchTrainingChats({ query: "remove", offset: 0, limit: 20, candidateIds })).total).toBe(0);
      expect(await store.searchTrainingChats({ query: "new", offset: 0, limit: 20, candidateIds })).toMatchObject({
        total: 1,
        entries: [{ sessionId: "codex_history_one", title: "Renamed" }],
      });
    });
  });

  test("reports message-index progress while metadata-only chats remain searchable by title", async () => {
    await withTrainingStore(async ({ store }) => {
      const document = {
        sessionId: "codex_history_progress",
        source: "codex" as const,
        signature: "metadata:v1",
        title: "Progressive indexing example",
        body: "",
        updatedAt: "2026-07-13T00:00:00.000Z",
        eligible: true,
        bodyIndexed: false,
      };
      await store.syncTrainingChatSearchDocuments("codex", [document]);
      expect(await store.searchTrainingChats({ query: "progressive", offset: 0, limit: 20, candidateIds: [document.sessionId] })).toMatchObject({
        total: 1,
        indexedChats: 0,
        totalChats: 1,
        indexing: true,
      });

      await store.upsertTrainingChatSearchDocument({ ...document, signature: "body:v1", body: "message-only sapphire marker", bodyIndexed: true });
      expect(await store.searchTrainingChats({ query: "sapphire", offset: 0, limit: 20, candidateIds: [document.sessionId] })).toMatchObject({
        total: 1,
        indexedChats: 1,
        totalChats: 1,
        indexing: false,
      });
    });
  });
});
