import { describe, expect, test } from "vitest";
import { createElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Experience,
  OpenPondApp,
  ProductArea,
} from "@openpond/contracts";

import {
  SidebarNavigation,
  SidebarUtilityNavigation,
} from "../apps/web/src/components/sidebar/SidebarNavigation";
import type { SidebarSectionMenuId } from "../apps/web/src/app/app-state";
import type { AppView } from "../apps/web/src/lib/app-models";

const noopDispatch = (() => undefined) as Dispatch<SetStateAction<never>>;

function renderSidebarNavigation(
  view: AppView,
  experience: Experience = "development",
  productArea: ProductArea = "development"
): string {
  const setView = ((_value: SetStateAction<AppView>) => undefined) as Dispatch<
    SetStateAction<AppView>
  >;
  return renderToStaticMarkup(
    createElement(SidebarNavigation, {
      experience,
      productArea,
      beginNewChat: (_app?: OpenPondApp | null) => undefined,
      setSectionMenuOpen: noopDispatch as Dispatch<
        SetStateAction<SidebarSectionMenuId | null>
      >,
      setSelectedAppId: noopDispatch as Dispatch<SetStateAction<string | null>>,
      setSelectedProjectId: noopDispatch as Dispatch<
        SetStateAction<string | null>
      >,
      setSelectedSessionId: noopDispatch as Dispatch<
        SetStateAction<string | null>
      >,
      setView,
      view,
    })
  );
}

function renderSidebarUtilityNavigation(
  view: AppView,
  experience: Experience = "development"
): string {
  const setView = ((_value: SetStateAction<AppView>) => undefined) as Dispatch<
    SetStateAction<AppView>
  >;
  return renderToStaticMarkup(
    createElement(SidebarUtilityNavigation, {
      experience,
      setSectionMenuOpen: noopDispatch as Dispatch<
        SetStateAction<SidebarSectionMenuId | null>
      >,
      setSelectedAppId: noopDispatch as Dispatch<SetStateAction<string | null>>,
      setSelectedProjectId: noopDispatch as Dispatch<
        SetStateAction<string | null>
      >,
      setSelectedSessionId: noopDispatch as Dispatch<
        SetStateAction<string | null>
      >,
      setView,
      view,
    })
  );
}

describe("Sidebar navigation", () => {
  test("does not render a Projects primary navigation entry", () => {
    const markup = renderSidebarNavigation("chat");

    expect(markup).toContain("New task");
    expect(markup).toContain("Profile");
    expect(markup).not.toContain("Models");
    expect(markup).not.toContain("Docs");
    expect(markup).toContain("Apps");
    expect(markup.indexOf("New task")).toBeLessThan(markup.indexOf("Profile"));
    expect(markup.indexOf("Profile")).toBeLessThan(markup.indexOf("Apps"));
    expect(markup).not.toContain("Projects");
    expect(markup).not.toContain("Agents");
    expect(markup).not.toContain("Training");
    expect(markup).not.toContain("Insights");
  });

  test("highlights Docs in the bottom utility navigation", () => {
    const markup = renderSidebarUtilityNavigation("get-started");

    expect(markup).toContain('aria-label="Docs"');
    expect(markup).toContain(
      'class="sidebar-icon sidebar-docs-button active"'
    );
    expect(markup).not.toContain("<span>Docs</span>");
  });

  test("highlights the standalone Profile and Models destinations independently", () => {
    const profile = renderSidebarNavigation("profile");
    const models = renderSidebarNavigation("labs", "development", "models");

    expect(profile).toContain('class="nav-command active" aria-label="Profile"');
    expect(profile).not.toContain('class="nav-command active" aria-label="Models"');
    expect(models).toContain('class="nav-command active" aria-label="Models"');
    expect(models).not.toContain('class="nav-command active" aria-label="Profile"');
    expect(models).not.toContain("sidebar-profile-change-dot");
    expect(models).not.toContain("Local profile changes are not committed");
  });

  test("keeps Chat and Work inside Chat with Schedule and Apps available", () => {
    const chat = renderSidebarNavigation("chat", "chat", "chat");
    const work = renderSidebarNavigation("chat", "work", "chat");
    const chatUtilities = renderSidebarUtilityNavigation("chat", "chat");
    const workUtilities = renderSidebarUtilityNavigation("chat", "work");

    expect(chat).toContain("New chat");
    expect(chat).toContain("Schedule");
    expect(chat).not.toContain("Models");
    expect(chat).toContain("Apps");
    expect(work).toContain("New task");
    expect(work).toContain("Schedule");
    expect(work).not.toContain("Models");
    expect(work).toContain("Apps");
    expect(chatUtilities).toContain('aria-label="Docs"');
    expect(chatUtilities).not.toContain("Apps");
    expect(workUtilities).toContain('aria-label="Docs"');
    expect(workUtilities).not.toContain("Apps");
  });
});
