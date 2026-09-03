import { describe, expect, test } from "vitest";

import {
  DEFAULT_SIDEBAR_TASK_VISIBILITY_PREFERENCES,
  readSidebarTaskVisibilityPreferences,
  SIDEBAR_TASK_VISIBILITY_STORAGE_KEY,
  writeSidebarTaskVisibilityPreferences,
} from "../apps/web/src/lib/sidebar-task-visibility-preferences";

describe("sidebar task visibility preferences", () => {
  test("round trips both task visibility switches across app mounts", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeSidebarTaskVisibilityPreferences(
      { showCodexChats: false, onlyRunningTasks: true },
      storage,
    );

    expect(values.has(SIDEBAR_TASK_VISIBILITY_STORAGE_KEY)).toBe(true);
    expect(readSidebarTaskVisibilityPreferences(storage)).toEqual({
      showCodexChats: false,
      onlyRunningTasks: true,
    });
  });

  test("falls back safely when persisted data is corrupt", () => {
    expect(
      readSidebarTaskVisibilityPreferences({ getItem: () => "not-json" }),
    ).toEqual(DEFAULT_SIDEBAR_TASK_VISIBILITY_PREFERENCES);
  });
});
