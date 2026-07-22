import {
  sidebarFileBookmarkId,
  type PatchSidebarFileBookmarkRequest,
  type SidebarFileBookmark,
} from "@openpond/contracts";
import { now } from "../utils.js";
import { SqliteCreateImproveStore } from "./store-create-improve.js";

type SidebarFileBookmarkRow = {
  workspace_kind: string;
  workspace_id: string;
  workspace_name: string;
  file_path: string;
  status: string;
  sort_order: number | null;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
};

export class SqliteSidebarFileBookmarkStore extends SqliteCreateImproveStore {
  async listSidebarFileBookmarks(scope: string): Promise<SidebarFileBookmark[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<SidebarFileBookmarkRow>(
      `SELECT workspace_kind, workspace_id, workspace_name, file_path, status, sort_order,
              source_session_id, created_at, updated_at
       FROM sidebar_file_bookmarks
       WHERE scope = ?
       ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, updated_at DESC`,
      [scope],
    );
    return rows.map((row) => {
      const workspaceKind = row.workspace_kind === "sandbox" ? "sandbox" : "local";
      const status = row.status === "saved_for_later" ? "saved_for_later" : "pinned";
      return {
        id: sidebarFileBookmarkId({ workspaceKind, workspaceId: row.workspace_id, path: row.file_path }),
        workspaceKind,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        path: row.file_path,
        status,
        order: row.sort_order,
        sourceSessionId: row.source_session_id,
        available: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async patchSidebarFileBookmark(
    scope: string,
    input: PatchSidebarFileBookmarkRequest,
  ): Promise<SidebarFileBookmark | null> {
    await this.ready;
    if (input.status === "none") {
      const write = this.writeQueue.then(() => this.run(
        `DELETE FROM sidebar_file_bookmarks
         WHERE scope = ? AND workspace_kind = ? AND workspace_id = ? AND file_path = ?`,
        [scope, input.workspaceKind, input.workspaceId, input.path],
      ));
      this.writeQueue = write.then(() => undefined, () => undefined);
      await write;
      return null;
    }
    const status: SidebarFileBookmark["status"] = input.status;
    let bookmark: SidebarFileBookmark | null = null;
    const write = this.writeQueue.then(async () => {
      const timestamp = now();
      const existing = await this.get<Pick<SidebarFileBookmarkRow, "created_at">>(
        `SELECT created_at FROM sidebar_file_bookmarks
         WHERE scope = ? AND workspace_kind = ? AND workspace_id = ? AND file_path = ?`,
        [scope, input.workspaceKind, input.workspaceId, input.path],
      );
      const createdAt = existing?.created_at ?? timestamp;
      await this.run(
        `INSERT INTO sidebar_file_bookmarks (
           scope, workspace_kind, workspace_id, workspace_name, file_path, status,
           sort_order, source_session_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, workspace_kind, workspace_id, file_path)
         DO UPDATE SET
           workspace_name = excluded.workspace_name,
           status = excluded.status,
           sort_order = excluded.sort_order,
           source_session_id = COALESCE(excluded.source_session_id, sidebar_file_bookmarks.source_session_id),
           updated_at = excluded.updated_at`,
        [
          scope,
          input.workspaceKind,
          input.workspaceId,
          input.workspaceName,
          input.path,
          status,
          input.order ?? null,
          input.sourceSessionId ?? null,
          createdAt,
          timestamp,
        ],
      );
      bookmark = {
        id: sidebarFileBookmarkId(input),
        workspaceKind: input.workspaceKind,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        path: input.path,
        status,
        order: input.order ?? null,
        sourceSessionId: input.sourceSessionId ?? null,
        available: true,
        createdAt,
        updatedAt: timestamp,
      };
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return bookmark;
  }
}
