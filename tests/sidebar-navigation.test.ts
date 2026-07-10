import { describe, expect, test } from "bun:test";
import { createElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpenPondApp } from "@openpond/contracts";

import { SidebarNavigation } from "../apps/web/src/components/sidebar/SidebarNavigation";
import type { SidebarSectionMenuId } from "../apps/web/src/app/app-state";
import type { AppView } from "../apps/web/src/lib/app-models";

const noopDispatch = (() => undefined) as Dispatch<SetStateAction<never>>;

function renderSidebarNavigation(view: AppView, profileHasUncommittedChanges = false): string {
  const setView = ((_value: SetStateAction<AppView>) => undefined) as Dispatch<SetStateAction<AppView>>;
  return renderToStaticMarkup(
    createElement(SidebarNavigation, {
      beginNewChat: (_app?: OpenPondApp | null) => undefined,
      profileHasUncommittedChanges,
      setSectionMenuOpen: noopDispatch as Dispatch<SetStateAction<SidebarSectionMenuId | null>>,
      setSelectedAppId: noopDispatch as Dispatch<SetStateAction<string | null>>,
      setSelectedProjectId: noopDispatch as Dispatch<SetStateAction<string | null>>,
      setSelectedSessionId: noopDispatch as Dispatch<SetStateAction<string | null>>,
      setView,
      view,
    }),
  );
}

describe("Sidebar navigation", () => {
  test("does not render a Projects primary navigation entry", () => {
    const markup = renderSidebarNavigation("chat");

    expect(markup).toContain("New task");
    expect(markup).toContain("Get started");
    expect(markup).toContain("Agents");
    expect(markup).toContain("Apps");
    expect(markup).not.toContain("Projects");
    expect(markup).not.toContain("Profile");
  });

  test("highlights the Get started primary navigation entry", () => {
    const markup = renderSidebarNavigation("get-started");

    expect(markup).toContain("Get started");
    expect(markup).toContain('class="nav-command active"');
  });

  test("shows profile nav change dot when local profile source is uncommitted", () => {
    const markup = renderSidebarNavigation("profile", true);

    expect(markup).toContain("Agents");
    expect(markup).toContain("nav-profile-command active");
    expect(markup).toContain("sidebar-profile-change-dot");
    expect(markup).toContain("Local profile changes are not committed");
    expect(markup).toContain('aria-label="Agents"');
  });
});
