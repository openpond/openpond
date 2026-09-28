import { describe, expect, it } from "vitest";
import { ModelUsageRecordSchema, type ModelUsageRecord } from "@openpond/contracts";
import type { AgentHostStorageClient } from "@openpond/agent-runtime";
import { HostedModelUsageStorage } from "./hosted-approval-usage-storage.js";

const record = ModelUsageRecordSchema.parse({
  id: "usage-1", requestId: "request-1", requestOrdinal: 0,
  sessionId: "session-1", turnId: "turn-1", provider: "openpond", model: "test-model",
  route: "openpond_hosted", source: "provider_usage", requestKind: "chat_turn",
  visibility: "user_facing", status: "completed", startedAt: "2026-09-27T00:00:00.000Z",
  completedAt: "2026-09-27T00:00:01.000Z", durationMs: 1000, firstTokenMs: null,
  promptTokens: 1, cachedPromptTokens: null, uncachedPromptTokens: null,
  cacheWritePromptTokens: null, cacheTelemetrySource: null, completionTokens: 1,
  totalTokens: 2, errorType: null, errorMessage: null,
  attribution: { surface: "chat", workflowKind: "direct_chat" },
});

describe("hosted usage complete reads", () => {
  it("reports overflow after bounded pages instead of returning a partial summary", async () => {
    let next = 0;
    const client = {
      request: async (request: { operation: string; params: { limit: number; before: unknown } }) => {
        expect(request.operation).toBe("usage/page");
        expect(request.params.limit).toBeLessThanOrEqual(200);
        const count = Math.min(request.params.limit, 10_001 - next);
        const records: ModelUsageRecord[] = Array.from({ length: count }, (_, offset) => ({
          ...record, id: `usage-${next + offset}`, requestId: `request-${next + offset}`,
          requestOrdinal: 10_001 - next - offset,
        }));
        next += count;
        const last = records.at(-1);
        return { records, nextBefore: last ? {
          startedAt: last.startedAt, requestOrdinal: last.requestOrdinal, id: last.id,
        } : null };
      },
    } as unknown as AgentHostStorageClient;
    await expect(new HostedModelUsageStorage(client).listModelUsageRecordsComplete({ sessionId: "session-1" }))
      .rejects.toThrow("exceeds 10000 rows");
    expect(next).toBe(10_001);
  });
});
