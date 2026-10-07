import type { PlanUsageWindow } from "@openpond/contracts";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function remaining(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, 100 - value)) : null;
}

function reset(value: unknown): string | null {
  const date = typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function durationLabel(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  if (value === 10080) return "Weekly";
  if (value % 1440 === 0) return `${value / 1440}-day`;
  if (value % 60 === 0) return `${value / 60}-hour`;
  return `${value}-minute`;
}

export function codexUsageWindows(payload: unknown): PlanUsageWindow[] {
  const response = record(payload);
  const buckets = record(response.rateLimitsByLimitId);
  const entries = Object.keys(buckets).length ? Object.entries(buckets) : [["codex", response.rateLimits] as const];
  return entries.flatMap(([id, value]) => {
    const bucket = record(value);
    return ["primary", "secondary"].flatMap((slot): PlanUsageWindow[] => {
      const window = record(bucket[slot]);
      const percent = remaining(window.usedPercent);
      if (percent === null) return [];
      const duration = durationLabel(window.windowDurationMins, slot === "primary" ? "Current window" : "Additional window");
      return [{ id: `${id}:${slot}`, label: id === "codex" ? duration : `${typeof bucket.limitName === "string" ? bucket.limitName : id} · ${duration}`, remainingPercent: percent, resetsAt: reset(window.resetsAt), shared: id === "codex" }];
    });
  });
}

export function claudeUsageWindows(payload: unknown): PlanUsageWindow[] {
  const response = record(payload);
  const labels: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet", seven_day_oauth_apps: "Weekly · OAuth apps", seven_day_cowork: "Weekly · Cowork" };
  return Object.entries(labels).flatMap(([id, label]): PlanUsageWindow[] => {
    const window = record(response[id]);
    const percent = remaining(window.utilization);
    return percent === null ? [] : [{ id, label, remainingPercent: percent, resetsAt: reset(window.resets_at), shared: id === "five_hour" || id === "seven_day" }];
  });
}
