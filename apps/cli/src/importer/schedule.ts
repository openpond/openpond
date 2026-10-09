import { syncTime, SYNC_WEEKDAYS, validateCollectorSchedule, type CollectorSchedule } from "@openpond/evals/native-conversations";
import { optionString, parseBooleanOption } from "../cli/common";

/** Cadence never grants permission to recur: --continual is the explicit opt-in. */
export function importSchedule(options: Record<string, string | boolean>): CollectorSchedule | null {
  if (options.everyMinute !== undefined) throw new Error("Every-minute imports are no longer supported. Use --continual --hourly or a slower schedule.");
  const continual = parseBooleanOption(options.continual);
  const choices = ["daily", "weekly", "hourly"].filter(key => parseBooleanOption(options[key]));
  if (options.cron !== undefined) choices.push("cron");
  const hasTiming = options.at !== undefined || options.on !== undefined;
  if (!continual && (choices.length || hasTiming))
    throw new Error("Add --continual to enable recurring imports. Without it, imports run once.");
  if (!continual) return null;
  if (choices.length > 1) throw new Error("Choose one cadence: --daily, --weekly, --hourly, or --cron.");
  if (options.off !== undefined) throw new Error("Choose --continual or --off, not both.");
  const frequency = choices[0] ?? "daily";
  if (["cron", "hourly"].includes(frequency)) {
    if (hasTiming) throw new Error("--at and --on are for daily/weekly imports; use a cron expression for other times.");
    if (frequency === "cron") return validateCollectorSchedule({ frequency: "cron", expression: optionString(options, "cron") });
    return { frequency: "hourly" };
  }
  if (frequency !== "weekly" && options.on !== undefined) throw new Error("--on selects a weekday and requires --weekly.");
  const time = syncTime(options.at === undefined ? "00:00" : optionString(options, "at"));
  if (frequency === "daily") return { frequency: "daily", time };
  const name = options.on === undefined ? "mon" : optionString(options, "on").toLowerCase();
  const day = SYNC_WEEKDAYS.findIndex(value => value === name);
  if (day < 0) throw new Error("Use --on sun|mon|tue|wed|thu|fri|sat (default: mon).");
  return { frequency: "weekly", time, day };
}
