import { describe, expect, test } from "vitest";
import { absoluteLocalVideoPath, isLocalVideoPath } from "../apps/web/src/lib/local-video";

describe("local video paths", () => {
  test("recognizes supported local video extensions", () => {
    expect(isLocalVideoPath("/home/glu/Videos/demo.mp4")).toBe(true);
    expect(isLocalVideoPath("demo.webm")).toBe(true);
    expect(isLocalVideoPath("demo.png")).toBe(false);
  });

  test("resolves workspace-relative videos without rewriting absolute paths", () => {
    expect(absoluteLocalVideoPath("renders/demo.mp4", "/home/glu/project")).toBe(
      "/home/glu/project/renders/demo.mp4",
    );
    expect(absoluteLocalVideoPath("/home/glu/Videos/demo.mp4", "/home/glu/project")).toBe(
      "/home/glu/Videos/demo.mp4",
    );
  });
});
