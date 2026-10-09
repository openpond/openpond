import { CronExpressionParser } from "cron-parser";

export interface ImportCalendar {
  minute: number[];
  hour: number[];
  month: number[];
  dayOfMonth: number[];
  dayOfWeek: number[];
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

/** Standard five-field cron: numbers, names, wildcards, lists, ranges and steps.
 * Excludes seconds and Quartz/randomized extensions so runs stay deterministic. */
export function parseImportCron(expression: string, now = new Date()) {
  if (expression.length > 512) throw new Error("Cron expressions must be at most 512 characters.");
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new Error("Use five cron fields: minute hour day-of-month month day-of-week.");
  const names = [[], [], [], ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]];
  const numeric = fields.map((field, index) => field.replace(/[a-z]+/giu, name => {
    const value = names[index]!.indexOf(name.toLowerCase());
    if (value < 0) throw new Error("Cron supports standard month/weekday names, numbers, *, lists, ranges and steps.");
    return String(value + (index === 3 ? 1 : 0));
  }));
  if (numeric.some(field => !/^[\d*,/\-]+$/u.test(field)))
    throw new Error("Cron supports numbers, *, lists, ranges and steps; second-level schedules are not supported.");
  const normalized = numeric.join(" ");
  const interval = CronExpressionParser.parse(normalized, {
    currentDate: now, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const cron = interval.fields;
  if (cron.minute.values.length !== 1)
    throw new Error("Imports support at most one scheduled run per hour. Choose a single cron minute, such as 0 or 30.");
  const calendar: ImportCalendar = {
    minute: [...cron.minute.values], hour: [...cron.hour.values], month: [...cron.month.values],
    dayOfMonth: cron.dayOfMonth.values.map(Number), dayOfWeek: [...new Set(cron.dayOfWeek.values.map(value => Number(value) % 7))],
    anyDayOfMonth: cron.dayOfMonth.isWildcard, anyDayOfWeek: cron.dayOfWeek.isWildcard,
  };
  return { expression: normalized, calendar, interval };
}

/** Deliberately self-contained: the same function is embedded in the tiny OS
 * launcher, which has no package imports and never reads source transcripts. */
export function importCalendarMatches(calendar: ImportCalendar, now: Date): boolean {
  const dom = calendar.dayOfMonth.includes(now.getDate());
  const dow = calendar.dayOfWeek.includes(now.getDay());
  const day = (!calendar.anyDayOfMonth && !calendar.anyDayOfWeek && (dom || dow)) ||
    (dom && calendar.anyDayOfWeek) || (calendar.anyDayOfMonth && !calendar.anyDayOfWeek && dow);
  return day && calendar.month.includes(now.getMonth() + 1) &&
    calendar.hour.includes(now.getHours()) && calendar.minute.includes(now.getMinutes());
}
