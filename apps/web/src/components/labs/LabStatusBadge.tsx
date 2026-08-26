import "../../styles/labs/lab-status.css";

export type LabStatusTone = "positive" | "info" | "warning" | "negative" | "neutral";

export function LabStatusBadge({
  label,
  value = label,
  tone,
  pulse = false,
}: {
  label: string;
  value?: string;
  tone?: LabStatusTone;
  pulse?: boolean;
}) {
  return (
    <span
      className={`labs-status-badge ${tone ?? labStatusTone(value)}${pulse ? " is-live" : ""}`}
      title={label}
    >
      {pulse ? <span aria-hidden="true" className="labs-status-live-dot" /> : null}
      <span className="labs-status-badge-label">{label}</span>
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
