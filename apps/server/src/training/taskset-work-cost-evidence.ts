export type WorkRuntimeCostEvidence = {
  receiptIds: string[];
  totalUsd: number;
  billableUsd: number;
  simulatedUsd: number;
  durationSeconds: number;
  settlementModes: string[];
};

export function workRuntimeCostEvidence(
  value: unknown,
): WorkRuntimeCostEvidence | null {
  const record = asRecord(value);
  const sandbox = asRecord(record.sandbox);
  const receiptValues = Array.isArray(record.receipts)
    ? record.receipts
    : Array.isArray(sandbox.receipts)
      ? sandbox.receipts
      : [];
  const receipts = receiptValues.map(asRecord);
  const captured = receipts.flatMap((receipt) => {
    const id = typeof receipt.id === "string" ? receipt.id : null;
    const totalUsd = numericUsd(receipt.totalUsd);
    const durationSeconds =
      typeof receipt.durationSeconds === "number"
      && Number.isFinite(receipt.durationSeconds)
      && receipt.durationSeconds >= 0
        ? receipt.durationSeconds
        : null;
    if (
      receipt.status !== "captured"
      || !id
      || totalUsd === null
      || durationSeconds === null
    ) {
      return [];
    }
    const settlement = asRecord(receipt.mpp).mode;
    return [{
      id,
      totalUsd,
      durationSeconds,
      settlementMode: typeof settlement === "string" ? settlement : null,
    }];
  });
  if (!captured.length) return null;
  return {
    receiptIds: captured.map((receipt) => receipt.id),
    totalUsd: sumUsd(captured.map((receipt) => receipt.totalUsd)),
    billableUsd: sumUsd(
      captured.flatMap((receipt) =>
        receipt.settlementMode === "mpp_service_hook"
          || receipt.settlementMode === "mpp_session_hook"
          ? [receipt.totalUsd]
          : []
      ),
    ),
    simulatedUsd: sumUsd(
      captured.flatMap((receipt) =>
        receipt.settlementMode === "simulated_poc"
          ? [receipt.totalUsd]
          : []
      ),
    ),
    durationSeconds: captured.reduce(
      (sum, receipt) => sum + receipt.durationSeconds,
      0,
    ),
    settlementModes: [
      ...new Set(
        captured.flatMap((receipt) =>
          receipt.settlementMode ? [receipt.settlementMode] : []
        ),
      ),
    ],
  };
}

export function sumUsd(values: number[]): number {
  return Number(
    values.reduce((sum, value) => sum + value, 0).toFixed(12),
  );
}

function numericUsd(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
