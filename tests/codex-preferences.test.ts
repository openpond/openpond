import { describe, expect, test } from "bun:test";
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

  test("builds a server sync patch only for stored values that differ", () => {
    const storage = new MemoryStorage();
    storage.setItem(CODEX_PERMISSION_MODE_STORAGE_KEY, "auto-review");
    storage.setItem(CODEX_REASONING_EFFORT_STORAGE_KEY, "medium");

    const patch = storedCodexPreferenceSyncPatch(
      {
        ...DEFAULT_APP_PREFERENCES,
        codexPermissionMode: "default",
        codexReasoningEffort: "medium",
      },
      storage,
    );

    expect(patch).toEqual({ codexPermissionMode: "auto-review" });
  });

  test("ignores invalid stored values", () => {
    const storage = new MemoryStorage();
    storage.setItem(CODEX_PERMISSION_MODE_STORAGE_KEY, "admin");
    storage.setItem(CODEX_REASONING_EFFORT_STORAGE_KEY, "maximum");

    expect(readStoredCodexChatPreferences(storage)).toEqual({});
    expect(storedCodexPreferenceSyncPatch(DEFAULT_APP_PREFERENCES, storage)).toEqual({});
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
