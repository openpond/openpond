import type { SidebarAppPreference, SidebarAppPreferences } from "@openpond/contracts";
import { normalizeSidebarAppPreference } from "../preferences.js";
import type { SidebarAppPreferenceRow } from "../types.js";
import { now } from "../utils.js";
import { SqliteStoreDomain } from "./store-domain.js";



export class SqliteSidebarPreferenceStore extends SqliteStoreDomain {


  async getSidebarAppPreferences(scope: string): Promise<SidebarAppPreferences> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<SidebarAppPreferenceRow>(
      `SELECT app_id, pinned, archived, sort_order
       FROM sidebar_app_preferences
       WHERE scope = ?`,
      [scope]
    );
    const preferences: SidebarAppPreferences = {};
    for (const row of rows) {
      preferences[row.app_id] = {
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        ...(row.sort_order === null ? {} : { order: row.sort_order }),
      };
    }
    return preferences;
  }

  async patchSidebarAppPreference(
    scope: string,
    appId: string,
    patch: SidebarAppPreference
  ): Promise<SidebarAppPreference> {
    await this.ready;
    let updated: SidebarAppPreference = {};
    const write = this.writeQueue.then(async () => {
      const row = await this.get<SidebarAppPreferenceRow>(
        `SELECT app_id, pinned, archived, sort_order
         FROM sidebar_app_preferences
         WHERE scope = ? AND app_id = ?`,
        [scope, appId]
      );
      const existing: SidebarAppPreference = row
        ? {
          pinned: row.pinned === 1,
          archived: row.archived === 1,
          ...(row.sort_order === null ? {} : { order: row.sort_order }),
        }
        : {};
      updated = normalizeSidebarAppPreference({ ...existing, ...patch });
      await this.run(
        `INSERT INTO sidebar_app_preferences (scope, app_id, pinned, archived, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, app_id)
         DO UPDATE SET
           pinned = excluded.pinned,
           archived = excluded.archived,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
        [scope, appId, updated.pinned ? 1 : 0, updated.archived ? 1 : 0, updated.order ?? null, now()]
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async reorderSidebarApps(scope: string, appIds: string[]): Promise<SidebarAppPreferences> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const updatedAt = now();
      await this.exec("BEGIN IMMEDIATE");
      try {
        for (const [index, appId] of appIds.entries()) {
          await this.run(
            `INSERT INTO sidebar_app_preferences (scope, app_id, pinned, archived, sort_order, updated_at)
             VALUES (?, ?, 0, 0, ?, ?)
             ON CONFLICT(scope, app_id)
             DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
            [scope, appId, index, updatedAt]
          );
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK");
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return this.getSidebarAppPreferences(scope);
  }
}
