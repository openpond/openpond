import { describe, expect, test } from "vitest";
import {
  initialStreamingText,
  nextStreamingText,
  streamingRevealStep,
} from "../apps/web/src/hooks/useSmoothStreamingText";
import { unseenMessageIds } from "../apps/web/src/hooks/useNewMessageIds";

describe("smooth streaming text", () => {
  test("reveals ordinary backlogs at a readable typewriter pace", () => {
    const step = streamingRevealStep(20, 16);

    expect(step.characterCount).toBe(1);
    expect(step.remainder).toBeCloseTo(0.024);
  });

  test("accelerates without flashing a large response all at once", () => {
    expect(streamingRevealStep(200, 16).characterCount).toBe(3);
    expect(streamingRevealStep(2_000, 16).characterCount).toBe(5);
  });

  test("does not reveal half of a Unicode surrogate pair", () => {
    expect(nextStreamingText("Hi ", "Hi 👋 there", 1)).toBe("Hi 👋");
  });

  test("never leaves a backgrounded response blank", () => {
    expect(initialStreamingText("Complete response", true, false)).toBe(
      "Complete response"
    );
    expect(initialStreamingText("Complete response", true, true)).toBe("C");
  });

  test("identifies live additions without treating loaded history as new", () => {
    const seenIds = new Set(["message_1"]);

    expect(
      [...unseenMessageIds([{ id: "message_1" }, { id: "message_2" }], seenIds)]
    ).toEqual(["message_2"]);
  });
});
