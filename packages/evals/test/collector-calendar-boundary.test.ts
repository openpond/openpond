import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { collectorServiceFiles } from "../src/native-conversations/collector-service-files.js";
import { nextScheduledSync, scheduledMinute, scheduledSyncDue, validateCollectorSchedule } from "../src/native-conversations/collector-schedule.js";
import type { CollectorSchedule } from "../src/native-conversations/collector-contracts.js";

const definition = (schedules: CollectorSchedule[]) => collectorServiceFiles({
  name: "calendar-fixture", executable: "/runtime/node", args: ["/cli/with spaces.js", "import", "service", "run", "--scheduled"],
  gatePath: "/fixture/calendar-gate.cjs", environment: [], schedules,
});

// Failure story: a cron expression is treated as daily, launches on the wrong
// weekday, catches up a missing DST time, or reloads the heavy CLI at every tick.
test("cron worker, next-run display, and generated calendar gate agree on actual due minutes", () => {
  const schedule = validateCollectorSchedule({ frequency: "cron", expression: "15 9-17 * * MON-FRI" });
  const due = new Date(2026, 9, 9, 9, 15, 20), notDue = new Date(2026, 9, 10, 9, 15, 20);
  expect(scheduledSyncDue(schedule, null, due)).toBe(true);
  expect(scheduledSyncDue(schedule, scheduledMinute(due), due)).toBe(false);
  expect(scheduledSyncDue(schedule, null, notDue)).toBe(false);
  expect(nextScheduledSync(schedule, due)).toBe(new Date(2026, 9, 9, 10, 15).toISOString());
  const source = definition([schedule]).gate;
  for (const [now, expected] of [[due, 1], [notDue, 0], [new Date(2026, 9, 9, 9, 16), 0]] as const) {
    const spawn = vi.fn(() => new EventEmitter());
    const require = vi.fn(() => ({ spawn }));
    class Clock extends Date { constructor() { super(now.getTime()); } }
    runInNewContext(source, { Date: Clock, require, process: new EventEmitter() });
    expect(require).toHaveBeenCalledTimes(expected);
    expect(spawn).toHaveBeenCalledTimes(expected);
    if (expected) expect(spawn.mock.calls[0]).toEqual([
      "/runtime/node", ["/cli/with spaces.js", "import", "service", "run", "--scheduled"], { stdio: "inherit", windowsHide: true },
    ]);
  }
  const eitherDay: CollectorSchedule = { frequency: "cron", expression: "0 0 1 * mon" };
  expect(scheduledSyncDue(eitherDay, null, new Date(2026, 9, 1))).toBe(true); // Thursday, but the first
  expect(scheduledSyncDue(eitherDay, null, new Date(2026, 9, 5))).toBe(true); // Monday, not the first
  expect(scheduledSyncDue(eitherDay, null, new Date(2026, 9, 6))).toBe(false);
  expect(nextScheduledSync({ frequency: "cron", expression: "0 0 29 feb *" }, new Date(2026, 9, 9))).toBe(new Date(2028, 1, 29).toISOString());
  const timezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    expect(nextScheduledSync({ frequency: "cron", expression: "30 2 * * *" }, new Date("2026-03-08T06:59:00Z")))
      .toBe("2026-03-09T06:30:00.000Z");
  } finally { if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone; }
  for (const expression of ["* * * * *", "*/15 * * * *", "0,30 * * * *", "* * * * * *", "61 * * * *", "0 0 L * *", "0 0 31 2 *", "H * * * *", "0 0 * * $(cmd)"])
    expect(() => validateCollectorSchedule({ frequency: "cron", expression })).toThrow();
});

// Failure story: the old once-per-day fence silently prevents frequent imports,
// or native definitions start hourly jobs at a different cadence.
test("hourly schedules use calendar ticks with no catch-up, restarts or overlap", () => {
  const at = new Date(2026, 9, 9, 9, 0, 20);
  expect(scheduledSyncDue({ frequency: "hourly" }, null, at)).toBe(true);
  expect(scheduledSyncDue({ frequency: "hourly" }, null, new Date(2026, 9, 9, 9, 1))).toBe(false);
  expect(nextScheduledSync({ frequency: "hourly" }, at)).toBe(new Date(2026, 9, 9, 10).toISOString());
  const hourly = definition([{ frequency: "hourly" }]);
  expect(hourly.timer).toContain("OnCalendar=*-*-* *:00:00");
  expect(hourly.plist).toContain("<dict><key>Minute</key><integer>0</integer></dict>");
  expect(hourly.windowsTask("user", "run.ps1")).toContain("<Interval>PT1H</Interval>");
  for (const schedule of [{ frequency: "cron", expression: "15 * * * *" }] as const) {
    const files = definition([schedule]);
    expect(files.timer).toContain("OnCalendar=*-*-* *:*:00");
    expect(files.timer).toContain("Persistent=false");
    expect(files.timer).toContain("WakeSystem=false");
    expect(files.plist).toContain("<key>StartCalendarInterval</key><array><dict/></array>");
    const windows = files.windowsTask("user", "run.ps1");
    expect(windows).toContain("<Interval>PT1M</Interval>");
    expect(windows).toContain("<StartWhenAvailable>false</StartWhenAvailable>");
    expect(windows).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  }
});
