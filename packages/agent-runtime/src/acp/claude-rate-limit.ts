import type { AcpObject } from "./types.js";

/** Use native quota metadata to identify the window; preserve its local reset wording. */
export function claudeRateLimitError(info: AcpObject | null, nativeText: string | null): string | null {
  if (!info || info.status !== "rejected") return null;
  const labels: Record<string, string> = {
    five_hour: "5-hour usage limit",
    seven_day: "Weekly usage limit",
    seven_day_opus: "Weekly Opus usage limit",
    seven_day_sonnet: "Weekly Sonnet usage limit",
  };
  const label = labels[String(info.rateLimitType)];
  if (!label) return null;
  const prefix = `Claude ${label} reached.`;
  const nativeReset = nativeText?.match(/\bresets\b[^\n]+/i)?.[0];
  if (nativeReset) return `${prefix} ${nativeReset[0].toUpperCase()}${nativeReset.slice(1)}`;
  if (typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)) {
    const date = new Date(info.resetsAt * 1000);
    if (Number.isFinite(date.getTime())) {
      const reset = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
      return `${prefix} Resets ${reset}.`;
    }
  }
  return nativeText ? `${prefix} ${nativeText}` : prefix;
}
