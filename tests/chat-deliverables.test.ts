import { describe, expect, test } from "vitest";
import type { ActivityItem } from "../apps/web/src/lib/app-models";
import { selectTurnDeliverables } from "../apps/web/src/lib/chat-deliverables";

describe("chat deliverables", () => {
  test("promotes only artifacts named by the final response", () => {
    const activities = [
      activity("source", artifact("/home/glu/Videos/source.mp4", "video/mp4")),
      activity("rendered", artifact("/home/glu/Videos/source_branded.mp4", "video/mp4")),
    ];

    expect(selectTurnDeliverables({
      activities,
      finalResponse: "Done: source_branded.mp4",
      settled: true,
    })).toEqual([
      expect.objectContaining({ path: "/home/glu/Videos/source_branded.mp4" }),
    ]);
  });

  test("keeps inspected images out of deliverables even when an older command reported them", () => {
    const previewPath = "/tmp/contact-sheet.jpg";
    const activities: ActivityItem[] = [
      activity("generated preview", artifact(previewPath, "image/jpeg")),
      {
        ...activity("inspected preview", artifact(previewPath, "image/jpeg")),
        imagePreview: { path: previewPath, appId: null, title: "contact-sheet.jpg" },
      },
      activity("rendered", artifact("/home/glu/Videos/final.mp4", "video/mp4")),
    ];

    expect(selectTurnDeliverables({
      activities,
      finalResponse: "Done: final.mp4",
      settled: true,
    })).toEqual([
      expect.objectContaining({ path: "/home/glu/Videos/final.mp4" }),
    ]);
  });

  test("shows every explicitly referenced output and otherwise falls back only after settling", () => {
    const activities = [
      activity("wide", artifact("/renders/wide.mp4", "video/mp4")),
      activity("vertical", artifact("/renders/vertical.mp4", "video/mp4")),
    ];

    expect(selectTurnDeliverables({
      activities,
      finalResponse: "Created [wide.mp4](/renders/wide.mp4) and vertical.mp4.",
      settled: true,
    })).toHaveLength(2);
    expect(selectTurnDeliverables({ activities, settled: false })).toEqual([]);
    expect(selectTurnDeliverables({ activities, settled: true })).toEqual([
      expect.objectContaining({ path: "/renders/vertical.mp4" }),
    ]);
  });
});

function activity(id: string, item: NonNullable<ActivityItem["artifacts"]>[number]): ActivityItem {
  return {
    id,
    label: "Ran",
    content: id,
    timestamp: "2026-07-22T00:00:00.000Z",
    artifacts: [item],
  };
}

function artifact(path: string, contentType: string): NonNullable<ActivityItem["artifacts"]>[number] {
  return {
    path,
    title: path.split("/").at(-1) ?? path,
    contentType,
    sizeBytes: 1024,
  };
}
