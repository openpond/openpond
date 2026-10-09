import {
  diagnosticFailure,
  diagnosticEvent,
  RunDiagnosticsQuerySchema,
  sealRunDiagnostics,
} from "openpond-sdk/experiments";
import type { LocalExperimentRecord } from "@openpond/contracts";
import type { LocalExperimentStorage } from "../store/store-local-experiments.js";

export async function readLocalRunDiagnostics(
  store: LocalExperimentStorage,
  execution: LocalExperimentRecord,
  raw: unknown,
) {
  const query = RunDiagnosticsQuerySchema.parse(raw);
  const [trace, charges] = await Promise.all([
    store.localExperimentDiagnosticTrace({
      teamId: execution.teamId,
      id: execution.id,
      afterSequence: query.afterSequence,
    }),
    store.readLocalExecutionCharges(execution.teamId, execution.id),
  ]);
  const selected = [...charges]
    .sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0))
    .filter((row) => !query.afterCallId || row.requestId > query.afterCallId)
    .slice(0, 101);
  const amount = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const settled = charges.filter((row) => row.status === "settled" && row.costUsd !== null);
  const outstanding = charges.filter((row) =>
    ["reserved", "dispatched", "unknown"].includes(row.status),
  );
  return sealRunDiagnostics({
    schemaVersion: "openpond.runDiagnostics.v1",
    teamId: execution.teamId,
    runId: execution.id,
    location: "local",
    manifestHash: execution.executionHash,
    observedAt: new Date().toISOString(),
    status: execution.status,
    startedAt: null,
    completedAt: execution.completedAt,
    error: diagnosticFailure(execution.error),
    resultAvailable: execution.counts.completed + execution.counts.failed > 0,
    parent: null,
    accounting: {
      maximumUsd: execution.maximumCostUsd,
      settledUsd: settled.length ? settled.reduce((sum, row) => sum + row.costUsd!, 0) : null,
      outstandingUsd: execution.usage.heldUsd,
      outstandingCount: outstanding.length,
      final:
        execution.completedAt !== null &&
        execution.usage.costUsd !== null &&
        settled.length > 0 &&
        outstanding.length === 0 &&
        execution.usage.heldUsd === 0,
      receiptCount: settled.length,
    },
    events: trace.items.map((row) =>
      diagnosticEvent({
        id: `local:${row.sequence}`,
        sequence: row.sequence,
        at: null,
        type: row.type,
        payload: {
          ...(row.payload !== null && typeof row.payload === "object" ? row.payload : {}),
          taskId: row.taskId,
        },
      }),
    ),
    eventCount: trace.count,
    nextEventCursor: trace.nextCursor,
    calls: selected.slice(0, 100).map((row) => {
      const usage =
        row.usage !== null && typeof row.usage === "object"
          ? (row.usage as Record<string, unknown>)
          : {};
      return {
        id: row.requestId,
        kind: "policy",
        status: row.status,
        receiptId: null,
        maximumUsd: row.maximumUsd,
        settledUsd: row.status === "settled" ? row.costUsd : null,
        model: execution.model.modelId,
        durationMs: amount(usage.durationMs),
        inputTokens: amount(usage.inputTokens ?? usage.promptTokens),
        outputTokens: amount(usage.outputTokens ?? usage.completionTokens),
        totalTokens: amount(usage.totalTokens),
      };
    }),
    nextCallCursor: selected.length > 100 ? selected[99]!.requestId : null,
    callCount: charges.length,
    limitations: [
      "Local execution records retain creation time but no measured execution start. Elapsed execution time is unknown.",
      "Local event records retain sequence but not wall timestamps; phase duration is unknown unless separately retained.",
      "Local provider charges may not retain token or timing receipts. Missing values remain unknown.",
      `Local resource cleanup: ${execution.cleanupComplete ? "confirmed" : "not confirmed"}.`,
      `Selected execution hash: ${execution.executionHash}.`,
    ],
  });
}
