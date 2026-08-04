import { describe, expect, test } from "vitest";
import type { FileOutputRef } from "@openpond/contracts";

import {
  outputFilePresentation,
  sortOutputFilesNewestFirst,
} from "../apps/web/src/components/outputs/output-file-model";

describe("desktop output file model", () => {
  test("classifies file types for labels and icons", () => {
    expect(outputFilePresentation(output("report.docx", "application/octet-stream"))).toEqual({
      label: "Document",
      type: "document",
    });
    expect(outputFilePresentation(output("metrics.csv", "text/csv"))).toEqual({
      label: "Table",
      type: "table",
    });
    expect(outputFilePresentation(output("clip.mp4", "video/mp4"))).toEqual({
      label: "Video",
      type: "video",
    });
  });

  test("sorts files newest first without mutating the source array", () => {
    const older = output("older.pdf", "application/pdf", "2026-08-01T12:00:00.000Z");
    const newer = output("newer.pdf", "application/pdf", "2026-08-03T12:00:00.000Z");
    const source = [older, newer];

    expect(sortOutputFilesNewestFirst(source).map((item) => item.title)).toEqual([
      "newer.pdf",
      "older.pdf",
    ]);
    expect(source).toEqual([older, newer]);
  });
});

function output(
  title: string,
  contentType: string,
  createdAt = "2026-08-03T12:00:00.000Z"
): FileOutputRef {
  return {
    kind: "file",
    id: title,
    title,
    contentType,
    sizeBytes: 100,
    sha256: "a".repeat(64),
    sourceTaskId: "task_1",
    sourceTurnId: "turn_1",
    revision: 1,
    createdAt,
    location: {
      kind: "local",
      path: `/managed/${title}`,
      deviceId: "device_1",
    },
    validation: [],
  };
}
