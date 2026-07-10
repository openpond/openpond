import type { ModelUsageRecord, RuntimeEvent } from "@openpond/contracts";
import { event, textFromUnknown } from "../../utils.js";

export function createSafeModelUsagePersistence(deps: {
  upsert?: ((record: ModelUsageRecord) => Promise<unknown>) | null;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
}) {
  return async function safeUpsertModelUsageRecord(record: ModelUsageRecord): Promise<void> {
    if (!deps.upsert) return;
    try {
      await deps.upsert(record);
    } catch (error) {
      await deps.appendRuntimeEvent(event({
        sessionId: record.sessionId ?? undefined,
        turnId: record.turnId ?? undefined,
        name: "diagnostic",
        source: "server",
        status: "failed",
        output: textFromUnknown(error) || "Failed to persist model usage record.",
        data: {
          kind: "model_usage_record_failed",
          requestId: record.requestId,
          provider: record.provider,
          model: record.model,
        },
      })).catch(() => undefined);
    }
  };
}
