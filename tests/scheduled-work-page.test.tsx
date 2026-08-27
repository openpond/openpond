import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  HostedSavedWorkSchedule,
  LocalAgentSchedule,
} from "@openpond/contracts";

import {
  filterAndSortLocalSchedules,
  formatScheduledRunAt,
  hostedConversationUrl,
  localScheduleCadence,
  ScheduledWorkPage,
  scheduleCadence,
} from "../apps/web/src/components/schedules/ScheduledWorkPage";

const NOW = "2026-08-03T12:00:00.000Z";

function schedule(
  id: string,
  input: Partial<LocalAgentSchedule> = {},
): LocalAgentSchedule {
  return {
    id,
    localProjectId: "project_1",
    localProjectName: "Reports",
    agentRootPath: "/agents/reports",
    agentName: "Report agent",
    scheduleName: id,
    scheduleType: "rate",
    scheduleExpression: "5 minutes",
    timezone: "UTC",
    targetAction: "write-report",
    input: { prompt: "Write the report." },
    enabledByDefault: true,
    enabled: true,
    sourceHash: id,
    manifestHash: null,
    agentVersionId: null,
    agentPackageDigest: null,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

describe("ScheduledWorkPage", () => {
  test("renders schedule controls without the scheduling composer", () => {
    const markup = renderToStaticMarkup(
      createElement(ScheduledWorkPage, {
        connection: null,
        detailOpen: false,
        detailExpanded: false,
        onDetailOpenChange: () => undefined,
        onDetailResizeStart: () => undefined,
        onToggleDetailExpanded: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Refresh schedules"');
    expect(markup).toContain('aria-label="Schedule filter"');
    expect(markup).toContain('aria-label="Workflow view"');
    expect(markup).toContain('aria-selected="true" class="active" role="tab" type="button">Calendar');
    expect(markup).toContain('<option value="all" selected="">All</option>');
    expect(markup).not.toContain("Ask OpenPond to schedule");
    expect(markup).not.toContain("Describe what you want to schedule");
    expect(markup).not.toContain("<textarea");
  });

  test("filters schedules and orders active work by its next run", () => {
    const rows = [
      schedule("later", { nextRunAt: "2026-08-05T12:00:00.000Z" }),
      schedule("paused", { enabled: false, nextRunAt: "2026-08-03T13:00:00.000Z" }),
      schedule("sooner", { nextRunAt: "2026-08-04T12:00:00.000Z" }),
      schedule("unscheduled"),
    ];

    expect(filterAndSortLocalSchedules(rows, "active").map((row) => row.id)).toEqual([
      "sooner",
      "later",
      "unscheduled",
    ]);
    expect(filterAndSortLocalSchedules(rows, "paused").map((row) => row.id)).toEqual([
      "paused",
    ]);
  });

  test("formats rate and common cron cadences", () => {
    expect(localScheduleCadence(schedule("heartbeat"))).toBe("Every 5 minutes · UTC");
    expect(
      localScheduleCadence(
        schedule("weekday", {
          scheduleType: "cron",
          scheduleExpression: "0 9 * * MON-FRI",
          timezone: "America/New_York",
        }),
      ),
    ).toBe("Weekdays at 9:00 AM · America/New_York");
    expect(scheduleCadence(hostedSchedule())).toBe(
      "Daily at 8:00 AM · America/New_York",
    );
    expect(formatScheduledRunAt("not-a-date", "UTC")).toBe("None");
  });

  test("builds external hosted conversation links", () => {
    expect(
      hostedConversationUrl("https://openpond.ai", "conversation/1")
    ).toBe("https://openpond.ai/sandboxes/work/conversation%2F1");
    expect(hostedConversationUrl("https://openpond.ai", null)).toBe(
      "https://openpond.ai/sandboxes/work"
    );
  });
});

function hostedSchedule(): HostedSavedWorkSchedule {
  return {
    id: "hosted_1",
    expression: null,
    timeZone: "America/New_York",
    recurrence: {
      version: 1,
      kind: "daily",
      timeZone: "America/New_York",
      startDate: "2026-08-04",
      localTime: "08:00",
      end: { kind: "never" },
    },
    configurationVersion: 1,
    enabled: true,
    nextRunAt: "2026-08-05T12:00:00.000Z",
    lastTriggeredAt: null,
    delivery: {},
  };
}
