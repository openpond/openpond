import type { CollectorSchedule } from "./collector-contracts.js";
import { importCalendarMatches, parseImportCron } from "./collector-cron.js";

export const SYNC_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Calendar times follow the host timezone, including daylight-saving changes. */
export function syncTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))
    throw new Error("Use a sync time in 24-hour HH:MM format, such as 00:00.");
  return value;
}

export function validateCollectorSchedule(schedule: CollectorSchedule): CollectorSchedule {
  if (schedule.frequency === "hourly") return { frequency: schedule.frequency };
  if (schedule.frequency === "cron") {
    const parsed = parseImportCron(schedule.expression);
    parsed.interval.next(); // Reject impossible calendars before installing an OS trigger.
    return { frequency: "cron", expression: parsed.expression };
  }
  const time = syncTime(schedule.time);
  if (schedule.frequency === "daily") return { frequency: "daily", time };
  if (schedule.frequency === "weekly" && Number.isInteger(schedule.day) && schedule.day >= 0 && schedule.day <= 6)
    return { frequency: "weekly", time, day: schedule.day };
  throw new Error("Choose a supported import frequency and, for weekly imports, a weekday from Sunday (0) to Saturday (6).");
}

export function scheduleExpression(schedule: CollectorSchedule): string {
  if (schedule.frequency === "cron") return schedule.expression;
  if (schedule.frequency === "hourly") return "0 * * * *";
  const [hour, minute] = schedule.time.split(":").map(Number);
  return `${minute} ${hour} * * ${schedule.frequency === "weekly" ? schedule.day : "*"}`;
}

export function scheduleDescription(schedule: CollectorSchedule) {
  if (schedule.frequency === "cron") return `cron ${schedule.expression}`;
  if (schedule.frequency === "hourly") return "hourly at minute 00";
  return schedule.frequency === "daily" ? `daily at ${schedule.time}` : `weekly on ${SYNC_WEEKDAYS[schedule.day]} at ${schedule.time}`;
}

export function localDay(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function scheduledMinute(now: Date) {
  return `${localDay(now)}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function nextScheduledSync(schedule: CollectorSchedule, now = new Date()): string {
  const { interval, calendar } = parseImportCron(scheduleExpression(schedule), now);
  // cron-parser can shift a missing spring-forward time to the next hour.
  // Only an actual matching wall-clock minute is a valid scheduled run.
  for (let attempt = 0; attempt < 10; attempt++) {
    const next = interval.next().toDate();
    if (importCalendarMatches(calendar, next)) return next.toISOString();
  }
  throw new Error("Unable to determine the next sync time.");
}

/** Reject delayed wake deliveries and duplicate launches within a scheduled minute. */
export function scheduledSyncDue(schedule: CollectorSchedule | null, lastMinute: string | null, now = new Date()) {
  if (!schedule || lastMinute === scheduledMinute(now)) return false;
  return importCalendarMatches(parseImportCron(scheduleExpression(schedule), now).calendar, now);
}
