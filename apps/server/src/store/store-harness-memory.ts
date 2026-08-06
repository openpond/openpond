import {
  type HarnessMemoryEntry,
  type HarnessMemoryWrite,
} from "@openpond/contracts";
import { contentHash } from "@openpond/evals";

import type { PayloadRow } from "../types.js";
import { SqliteSidebarFileBookmarkStore } from "./store-sidebar-file-bookmarks.js";

export class SqliteHarnessMemoryStore extends SqliteSidebarFileBookmarkStore {
  async listHarnessMemories(
    workspaceId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<HarnessMemoryEntry[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      `SELECT revisions.payload
       FROM harness_memory_revisions revisions
       INNER JOIN (
         SELECT key, MAX(revision) AS revision
         FROM harness_memory_revisions
         WHERE workspace_id = ?
         GROUP BY key
       ) latest ON latest.key = revisions.key AND latest.revision = revisions.revision
       WHERE revisions.workspace_id = ?
       ORDER BY revisions.created_at DESC, revisions.key ASC`,
      [workspaceId, workspaceId],
    );
    const entries = rows.map((row) => JSON.parse(row.payload) as HarnessMemoryEntry);
    return options.includeDeleted ? entries : entries.filter((entry) => entry.status === "active");
  }

  async getHarnessMemory(workspaceId: string, key: string): Promise<HarnessMemoryEntry | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      `SELECT payload FROM harness_memory_revisions
       WHERE workspace_id = ? AND key = ?
       ORDER BY revision DESC LIMIT 1`,
      [workspaceId, key],
    );
    return row ? JSON.parse(row.payload) as HarnessMemoryEntry : null;
  }

  async writeHarnessMemory(input: HarnessMemoryWrite): Promise<HarnessMemoryEntry> {
    const key = input.key.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(key)) {
      throw new Error("Harness memory keys must be lowercase slugs up to 120 characters.");
    }
    if (input.content !== null && (!input.content.trim() || input.content.length > 24_000)) {
      throw new Error("Harness memory content must contain 1-24,000 characters.");
    }
    await this.ready;
    let written: HarnessMemoryEntry | null = null;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        const existingRow = await this.get<PayloadRow>(
          `SELECT payload FROM harness_memory_revisions
           WHERE workspace_id = ? AND key = ?
           ORDER BY revision DESC LIMIT 1`,
          [input.workspaceId, key],
        );
        const existing = existingRow
          ? JSON.parse(existingRow.payload) as HarnessMemoryEntry
          : null;
        const observedRevision = existing?.revision ?? null;
        if (observedRevision !== input.expectedRevision) {
          throw new Error(
            `Harness memory ${key} changed concurrently (expected ${input.expectedRevision ?? "new"}, observed ${observedRevision ?? "new"}).`,
          );
        }
        if (input.content === null && (!existing || existing.status === "deleted")) {
          throw new Error(`Harness memory ${key} does not exist.`);
        }
        const revision = (existing?.revision ?? 0) + 1;
        const entryBase = {
          schemaVersion: "openpond.harnessMemoryEntry.v1" as const,
          id: existing?.id ?? `memory-${contentHash({ workspaceId: input.workspaceId, key }).slice(0, 24)}`,
          workspaceId: input.workspaceId,
          key,
          content: input.content?.trim() ?? "",
          tags: [...new Set((input.tags ?? existing?.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20),
          revision,
          status: input.content === null ? "deleted" as const : "active" as const,
          sourceRunId: input.sourceRunId,
          sourceProposal: input.sourceProposal,
          createdAt: existing?.createdAt ?? input.createdAt,
          updatedAt: input.createdAt,
        };
        written = {
          ...entryBase,
          contentHash: contentHash(entryBase),
        };
        await this.run(
          `INSERT INTO harness_memory_revisions (
             workspace_id, key, revision, status, payload, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.workspaceId,
            key,
            revision,
            written.status,
            JSON.stringify(written),
            input.createdAt,
          ],
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    if (!written) throw new Error("Harness memory write did not produce a revision.");
    return written;
  }
}
