import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { SidebarTaskListControls } from "../apps/web/src/components/sidebar/SidebarTaskListControls";

describe("sidebar task list controls", () => {
  test("shows the Codex and running visibility options with their defaults", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarTaskListControls, {
        filter: "active",
        groupByProject: true,
        noun: "tasks",
        onFilterChange: () => undefined,
        onGroupByProjectChange: () => undefined,
        onOnlyRunningTasksChange: () => undefined,
        onShowCodexChatsChange: () => undefined,
        onTasksetChange: () => undefined,
        onSortChange: () => undefined,
        onlyRunningTasks: false,
        openMenu: "chats",
        setOpenMenu: () => undefined,
        showCodexChats: true,
        sort: "recent",
        selectedTasksetId: null,
        tasksets: [],
      })
    );

    expect(markup).toContain("Show Codex chats");
    expect(markup).toContain("Only running tasks");
    expect(markup).toContain(
      'role="menuitemcheckbox" aria-checked="true"'
    );
    expect(markup).toContain(
      'role="menuitemcheckbox" aria-checked="false"'
    );
    expect(markup).toContain('aria-label="Task list options"');
  });
});
