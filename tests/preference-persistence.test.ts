import { describe, expect, test } from "vitest";
import {
  CODEX_PERMISSION_MODE_STORAGE_KEY,
  CODEX_REASONING_EFFORT_STORAGE_KEY,
  codexPreferencesWithLocalOverrides,
  readStoredCodexChatPreferences,
  storedCodexPreferenceSyncPatch,
  writeStoredCodexPermissionMode,
  writeStoredCodexReasoningEffort,
} from "../apps/web/src/lib/codex-preferences";
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

describe("Codex preference persistence", () => {
  test("defaults Codex reasoning to high when no explicit choice exists", () => {
    const storage = new MemoryStorage();

    expect(codexPreferencesWithLocalOverrides(null, storage)).toEqual({
      codexPermissionMode: "default",
      codexReasoningEffort: "high",
    });
  });

  test("uses stored Codex choices over stale bootstrap defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(CODEX_PERMISSION_MODE_STORAGE_KEY, "full-access");
    storage.setItem(CODEX_REASONING_EFFORT_STORAGE_KEY, "high");

    const preferences = codexPreferencesWithLocalOverrides(
      {
        ...DEFAULT_APP_PREFERENCES,
        codexPermissionMode: "default",
        codexReasoningEffort: "medium",
      },
      storage,
    );

    expect(preferences).toEqual({
      codexPermissionMode: "full-access",
      codexReasoningEffort: "high",
    });
  });

  test("writes Codex choices to storage", () => {
    const storage = new MemoryStorage();

    writeStoredCodexPermissionMode("full-access", storage);
    writeStoredCodexReasoningEffort("xhigh", storage);

    expect(readStoredCodexChatPreferences(storage)).toEqual({
      codexPermissionMode: "full-access",
      codexReasoningEffort: "xhigh",
    });
  });
});

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

  test("writes command access choices to storage", () => {
    const storage = new MemoryStorage();

    writeStoredOpenPondCommandAccessMode("disabled", storage);

    expect(readStoredOpenPondCommandAccessPreferences(storage)).toEqual({
      openPondCommandAccessMode: "disabled",
    });
  });
});

describe("local preference persistence contract", () => {
  test("syncs only valid stored values that differ from server preferences", () => {
    const codexStorage = new MemoryStorage();
    codexStorage.setItem(CODEX_PERMISSION_MODE_STORAGE_KEY, "auto-review");
    codexStorage.setItem(CODEX_REASONING_EFFORT_STORAGE_KEY, "medium");
    expect(storedCodexPreferenceSyncPatch({
      ...DEFAULT_APP_PREFERENCES,
      codexPermissionMode: "default",
      codexReasoningEffort: "medium",
    }, codexStorage)).toEqual({ codexPermissionMode: "auto-review" });

    const commandStorage = new MemoryStorage();
    commandStorage.setItem(OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY, "full-access");
    expect(storedOpenPondCommandAccessPreferenceSyncPatch({
      ...DEFAULT_APP_PREFERENCES,
      openPondCommandAccessMode: "ask",
    }, commandStorage)).toEqual({ openPondCommandAccessMode: "full-access" });
    expect(storedOpenPondCommandAccessPreferenceSyncPatch({
      ...DEFAULT_APP_PREFERENCES,
      openPondCommandAccessMode: "full-access",
    }, commandStorage)).toEqual({});
  });

  test("ignores invalid stored values across preference families", () => {
    const codexStorage = new MemoryStorage();
    codexStorage.setItem(CODEX_PERMISSION_MODE_STORAGE_KEY, "admin");
    codexStorage.setItem(CODEX_REASONING_EFFORT_STORAGE_KEY, "maximum");
    expect(readStoredCodexChatPreferences(codexStorage)).toEqual({});
    expect(storedCodexPreferenceSyncPatch(
      DEFAULT_APP_PREFERENCES,
      codexStorage,
    )).toEqual({});

    const commandStorage = new MemoryStorage();
    commandStorage.setItem(OPENPOND_COMMAND_ACCESS_MODE_STORAGE_KEY, "sudo");
    expect(readStoredOpenPondCommandAccessPreferences(commandStorage)).toEqual({});
    expect(storedOpenPondCommandAccessPreferenceSyncPatch(
      DEFAULT_APP_PREFERENCES,
      commandStorage,
    )).toEqual({});
  });
});
