import { SYNC_WEEKDAYS, validateCollectorSchedule } from "./collector-schedule.js";
import { collectorCalendarGate } from "./collector-calendar-gate.js";
import type { CollectorSchedule } from "./collector-contracts.js";

const WINDOWS_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const xml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
export const systemdQuote = (value: string) => `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/%/gu, "%%").replace(/\$/gu, () => "$$")}"`;
export const windowsQuote = (value: string) => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;

export function collectorServiceFiles(input: {
  name: string; executable: string; args: string[]; gatePath: string; environment: [string, string][]; schedules: CollectorSchedule[];
}) {
  const schedules = [...new Map(input.schedules.map(value => {
    const schedule = validateCollectorSchedule(value);
    return [JSON.stringify(schedule), schedule];
  })).values()];
  const command = [input.executable, input.gatePath];
  // Cron receives a cheap minute tick on platforms without native cron support.
  // The launcher checks the full expression before starting the importer.
  type Trigger = CollectorSchedule | { frequency: "calendar-tick" };
  const triggers: Trigger[] = schedules.some(schedule => schedule.frequency === "cron")
    ? [{ frequency: "calendar-tick" }] : schedules;
  const cron = (schedule: Trigger) => {
    if (schedule.frequency === "calendar-tick") return "*-*-* *:*:00";
    if (schedule.frequency === "hourly") return "*-*-* *:00:00";
    if (schedule.frequency === "cron") throw new Error("Cron needs the calendar gate.");
    return `${schedule.frequency === "weekly" ? `${SYNC_WEEKDAYS[schedule.day]} ` : ""}*-*-* ${schedule.time}:00`;
  };
  const launchd = (schedule: Trigger) => {
    if (schedule.frequency === "calendar-tick") return "<dict/>";
    if (schedule.frequency === "hourly") return "<dict><key>Minute</key><integer>0</integer></dict>";
    if (schedule.frequency === "cron") throw new Error("Cron needs the calendar gate.");
    const [hour, minute] = schedule.time.split(":").map(Number);
    return `<dict>${schedule.frequency === "weekly" ? `<key>Weekday</key><integer>${schedule.day}</integer>` : ""}<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
  };
  const windows = (schedule: Trigger) => {
    if (schedule.frequency === "calendar-tick" || schedule.frequency === "hourly")
      return `<CalendarTrigger><Repetition><Interval>${schedule.frequency === "hourly" ? "PT1H" : "PT1M"}</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
    if (schedule.frequency === "cron") throw new Error("Cron needs the calendar gate.");
    return `<CalendarTrigger><StartBoundary>2020-01-01T${schedule.time}:00</StartBoundary><Enabled>true</Enabled>${schedule.frequency === "daily" ? "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>" : `<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><${WINDOWS_WEEKDAYS[schedule.day]}/></DaysOfWeek></ScheduleByWeek>`}</CalendarTrigger>`;
  };
  return {
    gate: collectorCalendarGate({ executable: input.executable, args: input.args, schedules }),
    service: `[Unit]\nDescription=OpenPond conversation import job\nAfter=network-online.target\n[Service]\nType=oneshot\n${input.environment.map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join("\n")}\nExecStart=${command.map(systemdQuote).join(" ")}\nTimeoutStartSec=65min\nTimeoutStopSec=15s\nRestart=no\nNice=10\nUMask=0077\nNoNewPrivileges=true\n`,
    timer: `[Unit]\nDescription=OpenPond scheduled conversation imports\n[Timer]\n${triggers.map(schedule => `OnCalendar=${cron(schedule)}`).join("\n")}\nAccuracySec=1s\nRandomizedDelaySec=0\nPersistent=false\nWakeSystem=false\nUnit=${input.name}.service\n[Install]\nWantedBy=timers.target\n`,
    plist: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${input.name}</string><key>ProgramArguments</key><array>${command.map(value => `<string>${xml(value)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${input.environment.map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict><key>StartCalendarInterval</key><array>${triggers.map(launchd).join("")}</array><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>Nice</key><integer>10</integer></dict></plist>`,
    windowsTask(user: string, script: string) {
      return `<?xml version="1.0"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers>${triggers.map(windows).join("")}</Triggers><Principals><Principal id="Owner"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT65M</ExecutionTimeLimit></Settings><Actions Context="Owner"><Exec><Command>powershell.exe</Command><Arguments>${xml(["-NoProfile", "-NonInteractive", "-File", script].map(windowsQuote).join(" "))}</Arguments></Exec></Actions></Task>`;
    },
    powershell: `${input.environment.map(([key, value]) => `$env:${key} = '${value.replace(/'/gu, "''")}'`).join("\n")}\n& ${command.map(value => `'${value.replace(/'/gu, "''")}'`).join(" ")}\nexit $LASTEXITCODE\n`,
  };
}
