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
import { SIDEBAR_HELP_ITEMS } from "../apps/web/src/components/sidebar/SidebarHelpMenu";
import { CollaborationHeaderActions } from "../apps/web/src/components/collaboration/CollaborationHeaderActions";
import { CollaborationTabs } from "../apps/web/src/components/collaboration/CollaborationTabs";
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
    expect(markup).toContain('class="nav-command nav-command-new-task"');
    expect(markup).toContain('class="lucide lucide-plus"');
    expect(markup).not.toContain('class="lucide lucide-square-pen"');
    expect(markup).not.toContain("Profile");
    expect(markup).not.toContain("Models");
    expect(markup).not.toContain("Docs");
    expect(markup).not.toContain("Apps");
    expect(markup).not.toContain("Projects");
    expect(markup).not.toContain("Agents");
    expect(markup).not.toContain("Training");
    expect(markup).not.toContain("Insights");
  });

  test("shows the footer help menu and highlights Walkthroughs", () => {
    const markup = renderSidebarUtilityNavigation("get-started");

    expect(markup).toContain('aria-label="Open docs and help menu"');
    expect(markup).toContain(
      'class="sidebar-icon sidebar-help-trigger active"'
    );
    expect(SIDEBAR_HELP_ITEMS.map((item) => item.label)).toEqual([
      "Walkthroughs",
      "Docs",
      "Blog",
      "Pricing",
      "Web app",
      "GitHub",
      "Submit issue",
    ]);
    expect(SIDEBAR_HELP_ITEMS[1]).toMatchObject({
      label: "Docs",
      url: "https://openpond.ai/docs",
    });
  });

  test("renders Team chat and Discover as main header icons", () => {
    const markup = renderToStaticMarkup(
      createElement(CollaborationHeaderActions, {
        activeView: "team",
        onDiscoverCommunities: () => undefined,
        onOpenTeamChat: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Team chat"');
    expect(markup).toContain('class="titlebar-icon active"');
    expect(markup).toContain("lucide-message-square");
    expect(markup).not.toContain(">Team chat</button>");
    expect(markup).toContain('aria-label="Discover communities"');
    expect(markup).toContain("lucide-earth");
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  test("uses tabs for Team chat and Communities", () => {
    const markup = renderToStaticMarkup(
      createElement(CollaborationTabs, {
        onSelect: () => undefined,
        view: "community",
      }),
    );

    expect(markup).toContain('aria-label="Collaboration"');
    expect(markup).toContain(">Team chat</span>");
    expect(markup).toContain(">Communities</span>");
    expect(markup).not.toContain("lucide-message-square");
    expect(markup).toContain("lucide-earth");
    expect(markup).toContain('aria-current="page" class="active"');
  });

  test("highlights Scheduled, My files, and Models destinations independently", () => {
    const schedule = renderSidebarNavigation("scheduled", "work", "chat");
    const outputs = renderSidebarNavigation("outputs", "work", "chat");
    const models = renderSidebarNavigation("labs", "development", "models");

    expect(schedule).toContain('class="nav-command nav-command-prominent active" aria-label="Scheduled"');
    expect(schedule).not.toContain('class="nav-command nav-command-prominent active" aria-label="My files"');
    expect(schedule).not.toContain('class="nav-command active" aria-label="Models"');
    expect(outputs).toContain('class="nav-command nav-command-prominent active" aria-label="My files"');
    expect(outputs).not.toContain('class="nav-command nav-command-prominent active" aria-label="Scheduled"');
    expect(models).toContain('class="nav-command active" aria-label="Models"');
    expect(models).not.toContain('aria-label="Scheduled"');
    expect(models).not.toContain("sidebar-profile-change-dot");
    expect(models).not.toContain("Local profile changes are not committed");
  });

  test("keeps Chat and Work inside Chat with Scheduled and My files available", () => {
    const chat = renderSidebarNavigation("chat", "chat", "chat");
    const work = renderSidebarNavigation("chat", "work", "chat");
    const chatUtilities = renderSidebarUtilityNavigation("chat", "chat");
    const workUtilities = renderSidebarUtilityNavigation("chat", "work");

    expect(chat).toContain("New chat");
    expect(chat).toContain("Scheduled");
    expect(chat).toContain("My files");
    expect(chat).not.toContain("Profile");
    expect(chat).not.toContain("Models");
    expect(chat).not.toContain("Apps");
    expect(work).toContain("New task");
    expect(work).toContain("Scheduled");
    expect(work).toContain("My files");
    expect(work).not.toContain("Profile");
    expect(work).not.toContain("Models");
    expect(work).not.toContain("Apps");
    expect(chatUtilities).toContain('aria-label="Open docs and help menu"');
    expect(chatUtilities).not.toContain("Apps");
    expect(workUtilities).toContain('aria-label="Open docs and help menu"');
    expect(workUtilities).not.toContain("Apps");
  });
});
