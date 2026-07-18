import { labStatusTone, type LabStatusTone } from "./LabStatusBadge";

export function LabStatusDot({
  decorative = false,
  label,
  size = "default",
  tone,
  value = label,
}: {
  decorative?: boolean;
  label: string;
  size?: "default" | "small";
  tone?: LabStatusTone;
  value?: string;
}) {
  return (
    <span
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      className={`labs-status-dot ${tone ?? labStatusTone(value)} ${size}`}
      role={decorative ? undefined : "status"}
      title={label}
    />
  );
}
