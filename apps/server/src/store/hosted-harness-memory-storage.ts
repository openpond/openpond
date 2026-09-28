import { createHash, randomUUID } from "node:crypto";

import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import type { HarnessMemoryEntry, HarnessMemoryWrite } from "@openpond/contracts";
import { z } from "zod";

const memoryEntrySchema = z.object({
  schemaVersion: z.literal("openpond.harnessMemoryEntry.v1"),
  id: z.string().min(1), workspaceId: z.string().min(1), key: z.string().min(1),
  content: z.string(), tags: z.array(z.string()), revision: z.number().int().positive(),
  status: z.enum(["active", "deleted"]), sourceRunId: z.string().nullable(),
  sourceProposal: z.object({ id: z.string(), contentHash: z.string() }).strict().nullable(),
  createdAt: z.string(), updatedAt: z.string(), contentHash: z.string(),
}).strict();
const memoryPageSchema = z.object({
  entries: z.array(memoryEntrySchema).max(20),
  nextBefore: z.object({ updatedAt: z.string(), key: z.string() }).strict().nullable(),
}).strict();

/** Current memory reads are bounded; writes retain every revision on the host. */
export class HostedHarnessMemoryStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async getHarnessMemory(workspaceId: string, key: string): Promise<HarnessMemoryEntry | null> {
    const result = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
      operation: "harness/memory/get", params: { workspaceId, key },
    });
    return result === null ? null : memoryEntrySchema.parse(result);
  }

  async listHarnessMemories(workspaceId: string, options: { includeDeleted?: boolean } = {}): Promise<HarnessMemoryEntry[]> {
    const entries: HarnessMemoryEntry[] = [];
    let before: { updatedAt: string; key: string } | null = null;
    do {
      const page = memoryPageSchema.parse(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
        operation: "harness/memory/list",
        params: { workspaceId, includeDeleted: options.includeDeleted ?? false,
          before, limit: Math.min(10, 1_001 - entries.length) },
      }));
      entries.push(...page.entries);
      if (entries.length > 1_000) throw new Error("Hosted Harness memory list exceeds 1,000 entries.");
      if (page.nextBefore !== null && (page.entries.length === 0 ||
          (before !== null && (page.nextBefore.updatedAt > before.updatedAt ||
            (page.nextBefore.updatedAt === before.updatedAt && page.nextBefore.key <= before.key))))) {
        throw new Error("Host Harness memory cursor did not advance.");
      }
      before = page.nextBefore;
    } while (before !== null);
    return entries;
  }

  async writeHarnessMemory(input: HarnessMemoryWrite): Promise<HarnessMemoryEntry> {
    const requestId = `harness-memory:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
    const result = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId,
      operation: "harness/memory/write", params: { input: input as Record<string, unknown> },
    });
    const entry = memoryEntrySchema.parse(result);
    if (entry.workspaceId !== input.workspaceId || entry.key !== input.key.trim().toLowerCase()) {
      throw new Error("Host Harness memory response changed scope.");
    }
    return entry;
  }
}
