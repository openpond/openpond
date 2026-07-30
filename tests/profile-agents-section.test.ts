import { describe, expect, test } from "vitest";
import type { LocalAgentSchedule } from "@openpond/contracts";

import { partitionProfileSchedules } from "../apps/web/src/components/profile/ProfileAgentsSection";

const NOW = "2026-07-29T12:00:00.000Z";

function schedule(
  id: string,
  enabled: boolean,
  lastRunStatus: LocalAgentSchedule["lastRunStatus"],
): LocalAgentSchedule {
  return {
    id,
    localProjectId: "project_1",
    localProjectName: id,
    agentRootPath: `/agents/${id}`,
    agentName: id,
    scheduleName: `${id} schedule`,
    scheduleType: "cron",
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    targetAction: "chat",
    input: {},
    enabledByDefault: enabled,
    enabled,
    sourceHash: id,
    manifestHash: null,
    agentVersionId: null,
    agentPackageDigest: null,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus,
    lastRunId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("partitionProfileSchedules", () => {
  test("puts running and queued schedules before other enabled schedules, with paused schedules separate", () => {
    const grouped = partitionProfileSchedules([
      schedule("paused", false, null),
      schedule("idle", true, "succeeded"),
      schedule("queued", true, "queued"),
      schedule("running", true, "running"),
    ]);

    expect(grouped.active.map((entry) => entry.id)).toEqual([
      "running",
      "queued",
      "idle",
    ]);
    expect(grouped.paused.map((entry) => entry.id)).toEqual(["paused"]);
  });
});
