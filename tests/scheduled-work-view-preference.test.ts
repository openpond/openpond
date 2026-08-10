import { describe, expect, test } from "vitest";
import {
  readScheduledWorkViewMode,
  writeScheduledWorkViewMode,
} from "../apps/web/src/lib/scheduled-work-view-preference";

describe("scheduled work view preference", () => {
  test("defaults to calendar", () => {
    expect(readScheduledWorkViewMode(null)).toBe("calendar");
  });

  test("restores and writes the selected view", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeScheduledWorkViewMode("list", storage);
    expect(readScheduledWorkViewMode(storage)).toBe("list");
  });

  test("ignores unknown persisted values", () => {
    expect(readScheduledWorkViewMode({ getItem: () => "grid" })).toBe("calendar");
  });
});
