import type { ModelUsageRecord, RuntimeEvent } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";

export function createModelUsagePersistence(deps: {
  store: Pick<SqliteStore, "upsertModelUsageRecord">;
  appendRuntimeEvent: (item: RuntimeEvent) => Promise<void>;
}) {
  return async function safeUpsertModelUsageRecord(
    record: ModelUsageRecord
  ): Promise<void> {
    try {
      await deps.store.upsertModelUsageRecord(record);
    } catch (error) {
      await deps.appendRuntimeEvent(
        event({
          sessionId: record.sessionId ?? undefined,
          turnId: record.turnId ?? undefined,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output:
            error instanceof Error
              ? error.message
              : "Failed to persist model usage record.",
          data: {
            kind: "model_usage_record_failed",
            requestId: record.requestId,
            provider: record.provider,
            model: record.model,
          },
        })
      ).catch(() => undefined);
    }
  };
}
