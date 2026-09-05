import { AppPreferencesSchema, type AppPreferences } from "./schemas/settings.js";
import { readConfig, updateConfig, type ConfigSnapshot } from "./config.js";
import { configToPreferences, preferencesToConfig, layoutPreferences, type LayoutPreferences } from "./preference-config.js";
import { getLocalRecord, putLocalRecord } from "./database.js";
import { diffConfig } from "./toml-edit.js";
import { storagePaths } from "./home.js";
import { withFileLock } from "./private-file.js";

export async function readPreferences(home: string): Promise<{ preferences: AppPreferences; config: ConfigSnapshot }> {
  const config = await readConfig(home);
  const layout = getLocalRecord<LayoutPreferences>(home, "client_preferences", "global");
  return { preferences: configToPreferences(config.document, layout?.value), config };
}

/** Apply only the requested fields; unrelated defaults remain absent in the user's file. */
export async function updatePreferences(home: string, patch: Partial<AppPreferences>, expectedRevision?: string): Promise<{ preferences: AppPreferences; config: ConfigSnapshot }> {
  return withFileLock(`${storagePaths(home).runtime}/preferences`, async () => {
    const layout = getLocalRecord<LayoutPreferences>(home, "client_preferences", "global");
    let nextLayout = layout?.value;
    await updateConfig(home, (document) => {
      const current = configToPreferences(document, layout?.value);
      const next = AppPreferencesSchema.parse({ ...current, ...patch,
        ...(patch.defaultChatModelRef === undefined && (patch.defaultChatModel !== undefined || patch.defaultChatProvider !== undefined)
          ? { defaultChatModelRef: { providerId: patch.defaultChatProvider ?? current.defaultChatProvider, modelId: patch.defaultChatModel ?? current.defaultChatModel } } : {}),
      });
      nextLayout = layoutPreferences(next);
      const result = structuredClone(document) as Record<string, unknown>;
      for (const operation of diffConfig(preferencesToConfig(current), preferencesToConfig(next))) {
        let target = result;
        for (const segment of operation.path.slice(0, -1)) {
          target[segment] ??= {};
          target = target[segment] as Record<string, unknown>;
        }
        const key = operation.path.at(-1)!;
        if (operation.op === "set") target[key] = operation.value;
        else delete target[key];
      }
      return result as typeof document;
    }, expectedRevision);
    if (nextLayout && JSON.stringify(nextLayout) !== JSON.stringify(layout?.value)) {
      putLocalRecord(home, "client_preferences", "global", nextLayout, layout?.revision ?? null);
    }
    return readPreferences(home);
  });
}
