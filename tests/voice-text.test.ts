import { describe, expect, test } from "vitest";
import { insertVoiceTranscript } from "../apps/web/src/lib/voice-text";

describe("voice transcript insertion", () => {
  test("inserts transcript at the cursor with natural spacing", () => {
    expect(insertVoiceTranscript("Refactor this", "using the helper", 8)).toEqual({
      value: "Refactor using the helper this",
      cursorIndex: 25,
    });
  });

  test("does not add duplicate spaces around existing whitespace", () => {
    expect(insertVoiceTranscript("Start  end", "middle", 6)).toEqual({
      value: "Start middle end",
      cursorIndex: 12,
    });
  });

  test("normalizes transcript whitespace", () => {
    expect(insertVoiceTranscript("", "  fix   JSON   parsing  ", 0)).toEqual({
      value: "fix JSON parsing",
      cursorIndex: 16,
    });
  });
});
