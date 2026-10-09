import type { CollectorSchedule } from "./collector-contracts.js";
import { importCalendarMatches, parseImportCron } from "./collector-cron.js";
import { scheduleExpression } from "./collector-schedule.js";

/** A tiny, dependency-free process for OS schedulers that cannot express cron.
 * An unmatched calendar exits before importing the CLI or opening source files. */
export function collectorCalendarGate(input: { executable: string; args: string[]; schedules: CollectorSchedule[] }) {
  const calendars = input.schedules.map(schedule => parseImportCron(scheduleExpression(schedule)).calendar);
  return `"use strict";
const matches = ${importCalendarMatches.toString()};
const calendars = ${JSON.stringify(calendars)};
if (calendars.some(calendar => matches(calendar, new Date()))) {
  const { spawn } = require("node:child_process");
  const child = spawn(${JSON.stringify(input.executable)}, ${JSON.stringify(input.args)}, { stdio: "inherit", windowsHide: true });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
}
`;
}
