import { z } from "zod";

export const NightlyScheduleSchema = z.object({
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(200).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Choose a valid IANA timezone."),
}).strict();
export type NightlySchedule = z.infer<typeof NightlyScheduleSchema>;

const DAY = 86_400_000;
function formatter(calendar: NightlySchedule) {
  return new Intl.DateTimeFormat("en-US", { timeZone: calendar.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
function wallTime(format: Intl.DateTimeFormat, instant: number) {
  const parts = Object.fromEntries(format.formatToParts(instant).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
}
function localDay(format: Intl.DateTimeFormat, instant: number) { return Math.floor(wallTime(format, instant) / DAY) * DAY; }

/** One occurrence per local date. A repeated time uses its first occurrence;
 * a missing time advances by the DST gap. Entirely skipped dates have no fire. */
function occurrence(format: Intl.DateTimeFormat, calendar: NightlySchedule, date: number): number | null {
  const [hour, minute] = calendar.localTime.split(":").map(Number);
  const requested = date + hour! * 3_600_000 + minute! * 60_000;
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = requested + hours * 3_600_000;
    offsets.add(wallTime(format, probe) - probe);
  }
  const candidates = [...offsets].map(offset => requested - offset).sort((a, b) => a - b);
  const exact = candidates.find(instant => wallTime(format, instant) === requested);
  if (exact !== undefined) return exact;
  const shifted = candidates.filter(instant => localDay(format, instant) === date && wallTime(format, instant) > requested);
  return shifted.sort((a, b) => wallTime(format, a) - wallTime(format, b))[0] ?? null;
}

export function nextNightlyOccurrence(calendar: NightlySchedule, after: string): string {
  const parsed = NightlyScheduleSchema.parse(calendar);
  const time = Date.parse(after);
  if (!Number.isFinite(time)) throw new Error("A nightly schedule requires a valid timestamp.");
  const format = formatter(parsed);
  const date = localDay(format, time);
  for (let days = 0; days < 4; days++) {
    const candidate = occurrence(format, parsed, date + days * DAY);
    if (candidate !== null && candidate > time) return new Date(candidate).toISOString();
  }
  throw new Error("Unable to resolve the next nightly occurrence.");
}

export function coalesceNightlyOccurrences(calendar: NightlySchedule, due: string, now: string) {
  const parsed = NightlyScheduleSchema.parse(calendar);
  const format = formatter(parsed);
  const time = Date.parse(now);
  const date = localDay(format, time);
  for (let days = 0; days < 4; days++) {
    const candidate = occurrence(format, parsed, date - days * DAY);
    if (candidate !== null && candidate <= time) return {
      coalescedThroughAt: new Date(candidate).toISOString(),
      coalescedCount: Math.max(0, Math.round((localDay(format, candidate) - localDay(format, Date.parse(due))) / DAY)),
      nextRunAt: nextNightlyOccurrence(parsed, now),
    };
  }
  throw new Error("Unable to resolve the due nightly occurrence.");
}
