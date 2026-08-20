import { describe, expect, test } from "vitest";
import {
  autoTitlePromptFromPayload,
  fallbackSessionTitle,
  normalizeGeneratedSessionTitle,
  SESSION_TITLE_REASONING_EFFORT,
  withPendingAutoTitle,
} from "../apps/server/src/session-title-service";

describe("session title service", () => {
  test("disables reasoning for the small title request", () => {
    expect(SESSION_TITLE_REASONING_EFFORT).toBe("low");
  });

  test("normalizes model output to at most seven plain words", () => {
    expect(
      normalizeGeneratedSessionTitle(
        'Title: "Fix chat switching and stale streaming behavior now".',
        "fallback prompt",
      ),
    ).toBe("Fix chat switching and stale streaming behavior");
  });

  test("creates a bounded local fallback when title generation is unavailable", () => {
    expect(
      fallbackSessionTitle(
        "review how we create titles and add a typewriter animation",
      ).split(" "),
    ).toHaveLength(7);
  });

  test("marks auto-titled sessions as pending without changing other fields", () => {
    const payload = { provider: "openpond", title: "Raw prompt", autoTitlePrompt: "Summarize me" };
    expect(autoTitlePromptFromPayload(payload)).toBe("Summarize me");
    expect(withPendingAutoTitle(payload)).toEqual({ ...payload, title: "" });
  });
});
