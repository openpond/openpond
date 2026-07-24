import { describe, expect, test } from "vitest";
import type { ActivityItem } from "../apps/web/src/lib/app-models";
import {
  formatWorkTraceDuration,
  workTracePresentation,
} from "../apps/web/src/lib/chat-work-trace";
import { summarizeShellCommand } from "../apps/web/src/lib/chat-activity-summary";

function activities(count: number): ActivityItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `step_${index + 1}`,
    label: index % 2 === 0 ? "Reasoning" : "Ran",
    content: `Step ${index + 1}`,
    timestamp: `2026-07-22T15:00:0${index}.000Z`,
    kind: index % 2 === 0 ? "reasoning" : "command",
    state: "completed",
  }));
}

describe("chat work trace presentation", () => {
  test("keeps reasoning inline while tool rows are closed", () => {
    const live = workTracePresentation(activities(84), false);
    expect(live.toolsExpanded).toBe(false);
    expect(live.toolCount).toBe(42);
    expect(live.visibleActivities).toHaveLength(42);
    expect(live.visibleActivities.every((activity) => activity.kind === "reasoning")).toBe(true);
  });

  test("restores tool rows in their original transcript order when opened", () => {
    const collapsed = workTracePresentation(activities(6), false);
    expect(collapsed.visibleActivities.map((activity) => activity.id)).toEqual([
      "step_1",
      "step_3",
      "step_5",
    ]);

    const expanded = workTracePresentation(activities(6), true);
    expect(expanded.toolsExpanded).toBe(true);
    expect(expanded.toolCount).toBe(3);
    expect(expanded.visibleActivities.map((activity) => activity.id)).toEqual([
      "step_1",
      "step_2",
      "step_3",
      "step_4",
      "step_5",
      "step_6",
    ]);
  });

  test("formats stable completion durations", () => {
    expect(formatWorkTraceDuration("2026-07-22T15:00:00.000Z", "2026-07-22T15:01:24.000Z")).toBe("1m 24s");
    expect(formatWorkTraceDuration("2026-07-22T15:00:00.000Z", "2026-07-22T15:00:00.400Z")).toBeNull();
  });

  test("maps common shell commands to readable activity verbs", () => {
    expect(summarizeShellCommand('rg "activity-summary" apps/web/src')).toBe(
      'Searched for "activity-summary" in apps/web/src',
    );
    expect(summarizeShellCommand("rg --files apps/web/src")).toBe("Listed files matching apps/web/src");
    expect(summarizeShellCommand("ls -la apps/web/src")).toBe("Listed files in apps/web/src");
    expect(summarizeShellCommand("sed -n '1,120p' app.ts")).toBe("Read lines 1-120 of app.ts");
    expect(summarizeShellCommand("pnpm exec vitest run tests/chat-messages.test.ts")).toBe("Ran tests");
    expect(summarizeShellCommand("git diff --check")).toBe("Reviewed changes");
    expect(summarizeShellCommand("./cli --staging frontend deploy")).toBe("Ran cli command");
    expect(summarizeShellCommand("write_stdin")).toBe("Continued command");
    expect(summarizeShellCommand("js")).toBe("Ran JavaScript");
    expect(summarizeShellCommand("rg activity-summary apps/web/src", "running")).toBe(
      'Searching for "activity-summary" in apps/web/src',
    );
  });
});
