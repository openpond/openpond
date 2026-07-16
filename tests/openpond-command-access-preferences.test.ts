import { describe, expect, test } from "vitest";
import { DEFAULT_APP_PREFERENCES } from "../apps/web/src/lib/app-models";
import {
  OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY,
  openPondCommandAccessPreferencesWithLocalOverride,
  readStoredOpenPondCommandAccessPreferences,
  storedOpenPondCommandAccessPreferenceSyncPatch,
  writeStoredOpenPondCommandAccessMode,
} from "../apps/web/src/lib/openpond-command-access-preferences";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("OpenPond command access preference persistence", () => {
  test("uses stored command access over stale bootstrap defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY, "full-access");

    const preferences = openPondCommandAccessPreferencesWithLocalOverride(
      {
        ...DEFAULT_APP_PREFERENCES,
        openPondCommandAccessMode: "ask",
      },
      storage,
    );

    expect(preferences).toEqual({ openPondCommandAccessMode: "full-access" });
  });

  test("builds a server sync patch only for stored values that differ", () => {
    const storage = new MemoryStorage();
    storage.setItem(OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY, "full-access");

    const patch = storedOpenPondCommandAccessPreferenceSyncPatch(
      {
        ...DEFAULT_APP_PREFERENCES,
        openPondCommandAccessMode: "ask",
      },
      storage,
    );

    expect(patch).toEqual({ openPondCommandAccessMode: "full-access" });
    expect(
      storedOpenPondCommandAccessPreferenceSyncPatch(
        {
          ...DEFAULT_APP_PREFERENCES,
          openPondCommandAccessMode: "full-access",
        },
        storage,
      ),
    ).toEqual({});
  });

  test("ignores invalid stored values", () => {
    const storage = new MemoryStorage();
    storage.setItem(OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY, "sudo");

    expect(readStoredOpenPondCommandAccessPreferences(storage)).toEqual({});
    expect(storedOpenPondCommandAccessPreferenceSyncPatch(DEFAULT_APP_PREFERENCES, storage)).toEqual({});
  });

  test("writes command access choices to storage", () => {
    const storage = new MemoryStorage();

    writeStoredOpenPondCommandAccessMode("disabled", storage);

    expect(readStoredOpenPondCommandAccessPreferences(storage)).toEqual({
      openPondCommandAccessMode: "disabled",
    });
  });
});
