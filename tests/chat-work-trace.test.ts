import { describe, expect, test } from "vitest";
import type { ActivityItem } from "../apps/web/src/lib/app-models";
import {
  formatWorkTraceDuration,
  workTracePresentation,
} from "../apps/web/src/lib/chat-work-trace";

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
  test("shows the first five live steps, then folds earlier work on the sixth", () => {
    const firstFive = workTracePresentation(activities(5), "running", null);
    expect(firstFive.expanded).toBe(true);
    expect(firstFive.visibleActivities.map((activity) => activity.id)).toEqual([
      "step_1",
      "step_2",
      "step_3",
      "step_4",
      "step_5",
    ]);

    const sixth = workTracePresentation(activities(6), "running", null);
    expect(sixth.expanded).toBe(false);
    expect(sixth.hiddenCount).toBe(5);
    expect(sixth.visibleActivities.map((activity) => activity.id)).toEqual(["step_6"]);
  });

  test("respects manual expansion while running and after completion", () => {
    const liveExpanded = workTracePresentation(activities(6), "running", true);
    expect(liveExpanded.expanded).toBe(true);
    expect(liveExpanded.visibleActivities).toHaveLength(6);

    const completed = workTracePresentation(activities(6), "completed", null);
    expect(completed.expanded).toBe(false);
    expect(completed.visibleActivities).toHaveLength(0);

    const completedExpanded = workTracePresentation(activities(6), "completed", true);
    expect(completedExpanded.expanded).toBe(true);
    expect(completedExpanded.visibleActivities).toHaveLength(6);
  });

  test("formats stable completion durations", () => {
    expect(formatWorkTraceDuration("2026-07-22T15:00:00.000Z", "2026-07-22T15:01:24.000Z")).toBe("1m 24s");
    expect(formatWorkTraceDuration("2026-07-22T15:00:00.000Z", "2026-07-22T15:00:00.400Z")).toBeNull();
  });
});
