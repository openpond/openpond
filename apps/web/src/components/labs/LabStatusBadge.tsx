export type LabStatusTone = "positive" | "info" | "warning" | "negative" | "neutral";

export function LabStatusBadge({
  label,
  value = label,
}: {
  label: string;
  value?: string;
}) {
  return (
    <span className={`labs-status-badge ${labStatusTone(value)}`}>
      {label}
    </span>
  );
}

export function labStatusTone(value: string): LabStatusTone {
  const normalized = value.trim().toLowerCase().replaceAll("_", " ");
  if (
    normalized.includes("ready") ||
    normalized.includes("passed") ||
    normalized.includes("succeeded") ||
    normalized.includes("published") ||
    normalized.includes("released") ||
    normalized.includes("merged") ||
    normalized.includes("imported")
  ) {
    return "positive";
  }
  if (
    normalized.includes("planning") ||
    normalized.includes("applying") ||
    normalized.includes("running") ||
    normalized.includes("evaluating") ||
    normalized.includes("pushing")
  ) {
    return "info";
  }
  if (
    normalized.includes("awaiting") ||
    normalized.includes("paused") ||
    normalized.includes("pr open") ||
    normalized.includes("blocked") ||
    normalized.includes("review") ||
    normalized.includes("dirty") ||
    normalized.includes("pending")
  ) {
    return "warning";
  }
  if (
    normalized.includes("failed") ||
    normalized.includes("rejected") ||
    normalized.includes("closed") ||
    normalized.includes("error") ||
    normalized.includes("disabled")
  ) {
    return "negative";
  }
  return "neutral";
}
