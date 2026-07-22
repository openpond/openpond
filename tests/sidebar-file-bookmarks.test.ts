import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  normalizeSidebarFilePath,
  sidebarFileBookmarkId,
} from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store";
import { SidebarFileRow } from "../apps/web/src/components/sidebar/SidebarRows";
import { WorkspaceDiffTabs } from "../apps/web/src/components/workspace-diff/WorkspaceDiffPanelChrome";
import { WorkspaceFileBookmarkActions } from "../apps/web/src/components/workspace-diff/WorkspaceFileBookmarkActions";
import { WorkspaceFileTree } from "../apps/web/src/components/workspace-diff/WorkspaceFileTree";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const sqliteTest = nodeMajor === 24 && (nodeMinor ?? 0) >= 18 ? test : test.skip;

describe("sidebar file bookmarks", () => {
  test("normalizes workspace-relative file paths and rejects escapes", () => {
    expect(normalizeSidebarFilePath("./docs\\plan.md")).toBe("docs/plan.md");
    expect(normalizeSidebarFilePath("workspace:file:docs/plan.md")).toBe("docs/plan.md");
    expect(normalizeSidebarFilePath("/workspace/app/docs/plan.md")).toBe("docs/plan.md");
    expect(() => normalizeSidebarFilePath("../outside.md")).toThrow("cannot leave the workspace");
    expect(() => normalizeSidebarFilePath("/tmp/outside.md")).toThrow("relative to the workspace");
  });

  test("renders a compact filename row with location hover text and both status controls", () => {
    const file = {
      id: "file_1",
      workspaceKind: "local" as const,
      workspaceId: "project_1",
      workspaceName: "OpenPond",
      path: "docs/design/plan.md",
      status: "pinned" as const,
      order: 1,
      sourceSessionId: null,
      available: true,
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
    };
    const markup = renderToStaticMarkup(createElement(SidebarFileRow, {
      file,
      onSelect: () => undefined,
      onTogglePin: () => undefined,
      onToggleSaveForLater: () => undefined,
    }));
    expect(markup).toContain(">plan.md<");
    expect(markup).toContain('title="OpenPond · docs/design/plan.md"');
    expect(markup).toContain('aria-label="Unpin file"');
    expect(markup).toContain('aria-label="Save file for later"');

    const header = renderToStaticMarkup(createElement(WorkspaceFileBookmarkActions, {
      currentStatus: "saved_for_later",
      onSetStatus: () => undefined,
    }));
    expect(header).toContain('aria-label="Pin file"');
    expect(header).toContain('aria-label="Remove from Save for later"');
  });

  test("renders file bookmark controls in the Files tree and open-file tabs", () => {
    const fileStatuses = new Map([
      ["docs/plan.md", "pinned" as const],
    ]);
    const tree = renderToStaticMarkup(createElement(WorkspaceFileTree, {
      changedByPath: new Map(),
      expandedFolderPaths: new Set(["docs"]),
      repoFiles: ["docs/plan.md"],
      selectedPath: "docs/plan.md",
      getFileBookmarkStatus: (filePath: string) => fileStatuses.get(filePath) ?? null,
      onOpenFile: () => undefined,
      onSetFileBookmarkStatus: () => undefined,
      onToggleFolder: () => undefined,
    }));
    expect(tree).toContain("workspace-file-tree-bookmark-actions");
    expect(tree).toContain('aria-label="Unpin file"');
    expect(tree).toContain('aria-label="Save file for later"');

    const tabs = renderToStaticMarkup(createElement(WorkspaceDiffTabs, {
      addMenuOpen: false,
      expanded: false,
      filteredFiles: [],
      dirtyFilePaths: new Set<string>(),
      openFiles: [{
        path: "docs/plan.md",
        status: "unchanged",
        additions: 0,
        deletions: 0,
        patch: "",
        content: "# Plan",
      }],
      goalDetailsAvailable: false,
      searchOpen: false,
      searchQuery: "",
      selectedPath: "docs/plan.md",
      visibleTab: "file",
      getFileBookmarkStatus: () => "saved_for_later",
      onCloseFileTab: () => undefined,
      onCloseSearch: () => undefined,
      onOpenFile: () => undefined,
      onOpenBrowser: () => undefined,
      onOpenSearch: () => undefined,
      onSearchQueryChange: () => undefined,
      onSetFileBookmarkStatus: () => undefined,
      onSelectFile: () => undefined,
      onSelectFiles: () => undefined,
      onSelectGoal: () => undefined,
      onToggleAddMenu: () => undefined,
      onToggleExpanded: () => undefined,
    }));
    expect(tabs).toContain("workspace-diff-tab-bookmark-actions");
    expect(tabs).toContain('aria-label="Pin file"');
    expect(tabs).toContain('aria-label="Remove from Save for later"');
    expect(tabs).toContain('title="Close docs/plan.md"');
  });

  sqliteTest("uses a stable identity while moving a file between sidebar statuses", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-sidebar-files-"));
    const store = new SqliteStore(storeDir);
    const base = {
      workspaceKind: "local" as const,
      workspaceId: "project_1",
      workspaceName: "OpenPond",
      path: "docs/plan.md",
      sourceSessionId: "session_1",
    };

    try {
      const pinned = await store.patchSidebarFileBookmark("account_1", {
        ...base,
        status: "pinned",
        order: 2,
      });
      expect(pinned).toMatchObject({
        id: sidebarFileBookmarkId(base),
        status: "pinned",
        order: 2,
      });

      const saved = await store.patchSidebarFileBookmark("account_1", {
        ...base,
        status: "saved_for_later",
      });
      expect(saved).toMatchObject({ id: pinned?.id, status: "saved_for_later" });
      expect(await store.listSidebarFileBookmarks("account_1")).toHaveLength(1);
      expect((await store.listSidebarFileBookmarks("account_1"))[0]?.status).toBe("saved_for_later");

      await store.patchSidebarFileBookmark("account_1", { ...base, status: "none" });
      expect(await store.listSidebarFileBookmarks("account_1")).toEqual([]);
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
