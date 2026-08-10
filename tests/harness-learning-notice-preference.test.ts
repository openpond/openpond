import { describe, expect, test } from "vitest";

import {
  HARNESS_LEARNING_NOTICE_DISMISSED_KEY,
  readHarnessLearningNoticeDismissed,
  rememberHarnessLearningNoticeDismissed,
} from "../apps/web/src/lib/harness-learning-notice-preference";

describe("Continuous learning sidebar dismissal", () => {
  test("stays dismissed after the first close", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readHarnessLearningNoticeDismissed(storage)).toBe(false);
    rememberHarnessLearningNoticeDismissed(storage);
    expect(values.get(HARNESS_LEARNING_NOTICE_DISMISSED_KEY)).toBe("true");
    expect(readHarnessLearningNoticeDismissed(storage)).toBe(true);
  });

  test("falls back safely when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readHarnessLearningNoticeDismissed(storage)).toBe(false);
    expect(() => rememberHarnessLearningNoticeDismissed(storage)).not.toThrow();
  });
});
