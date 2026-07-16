import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";

import { initialAppState, appReducer } from "../apps/web/src/app/app-state";
import { LabsExtensions } from "../apps/web/src/components/labs/LabsExtensions";
import { LabsView, LABS_TABS } from "../apps/web/src/components/labs/LabsView";
import { ProfileView } from "../apps/web/src/components/profile/ProfileView";
import { SidebarNavigation } from "../apps/web/src/components/sidebar/SidebarNavigation";

const noop = () => undefined;

describe("Lab Phase 1", () => {
  test("makes Profile the first and default Lab tab", () => {
    expect(initialAppState.labsTab).toBe("profile");
    expect(LABS_TABS.map((tab) => tab.id)).toEqual([
      "profile",
      "signals",
      "evals",
      "models",
      "agents",
      "extensions",
    ]);

    const markup = renderToStaticMarkup(
      createElement(LabsView, {
        activeTab: "profile",
        onNewModel: noop,
        onTabChange: noop,
        children: createElement("div", null, "Profile home"),
      }),
    );

    expect(markup).toContain('aria-label="Lab sections"');
    expect(markup).toContain('id="labs-tab-profile"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup.indexOf(">Profile</span>")).toBeLessThan(markup.indexOf(">Signals</span>"));
    expect(markup.indexOf(">Signals</span>")).toBeLessThan(markup.indexOf(">Evals</span>"));
    expect(markup.indexOf(">Evals</span>")).toBeLessThan(markup.indexOf(">Models</span>"));
    expect(markup.indexOf(">Models</span>")).toBeLessThan(markup.indexOf(">Agents</span>"));
    expect(markup.indexOf(">Agents</span>")).toBeLessThan(markup.indexOf(">Extensions</span>"));
    expect(markup).toContain("Profile home");
    expect(markup).toContain(">New model</span>");
    expect(markup).not.toContain("Build, test, and improve your system");
    expect(markup).not.toContain("<h1>");

    const changedMarkup = renderToStaticMarkup(
      createElement(LabsView, {
        activeTab: "profile",
        onNewModel: noop,
        onTabChange: noop,
        profileHasUncommittedChanges: true,
        children: createElement("div", null, "Profile home"),
      }),
    );
    expect(changedMarkup).toContain("labs-profile-change-dot");
    expect(changedMarkup).toContain("Profile has local changes that are not committed");
  });

  test("keeps explicit tab selection in application route state", () => {
    const next = appReducer(initialAppState, {
      type: "field",
      key: "labsTab",
      value: "signals",
    });
    expect(next.labsTab).toBe("signals");
    expect(next.view).toBe("chat");

    const opened = appReducer(next, {
      type: "field",
      key: "view",
      value: "labs",
    });
    expect(opened).toMatchObject({ view: "labs", labsTab: "signals" });
  });

  test("replaces the old primary destinations with one Lab entry", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarNavigation, {
        beginNewChat: noop,
        setSectionMenuOpen: noop,
        setSelectedAppId: noop,
        setSelectedProjectId: noop,
        setSelectedSessionId: noop,
        setLabsTab: noop,
        setView: noop,
        view: "labs",
      }),
    );

    expect(markup).toContain('aria-label="Lab"');
    expect(markup).toContain("duck-icon");
    expect(markup).not.toContain("lucide-beaker");
    expect(markup).toContain(">Lab</span>");
    expect(markup).not.toContain(">Training</span>");
    expect(markup).not.toContain(">Insights</span>");
    expect(markup).not.toContain('aria-label="Agents"');
    expect(markup).not.toContain("Local profile changes are not committed");
  });

  test("keeps the Extensions mount truthful before the runtime exists", () => {
    const markup = renderToStaticMarkup(createElement(LabsExtensions));
    expect(markup).toContain("Your mutable harness modules will live here");
    expect(markup).toContain("Extension runtime unavailable");
    expect(markup).not.toContain("Make Active");
  });

  test("separates Profile controls from the detailed Agents inventory", () => {
    const shared = {
      payload: null,
      connection: null,
      onPayload: noop,
      onError: noop,
    };
    const profileMarkup = renderToStaticMarkup(createElement(ProfileView, { ...shared, section: "profile" }));
    const agentsMarkup = renderToStaticMarkup(createElement(ProfileView, { ...shared, section: "agents" }));

    expect(profileMarkup).toContain("No local profile loaded");
    expect(profileMarkup).toContain("Create a default profile here");
    expect(agentsMarkup).toContain("No local Profile loaded");
    expect(agentsMarkup).toContain("Open the Profile tab");
    expect(agentsMarkup).not.toContain("Create a default profile here");
  });

  test("keeps heavy Lab panels behind conditional imports", async () => {
    const route = await readFile("apps/web/src/components/labs/LabsRoute.tsx", "utf8");
    for (const component of ["LabsProfile", "LabsExtensions", "LabsSignals", "ProfileView", "TrainingView"]) {
      expect(route).toContain(`const ${component} = lazy(`);
    }
  });

  test("routes an agent receipt back to the focused Agents workspace", async () => {
    const appSource = await readFile("apps/web/src/App.tsx", "utf8");
    const openAgentSettings = appSource.slice(
      appSource.indexOf("const openProfileSettings"),
      appSource.indexOf("const diagnosticEvents"),
    );

    expect(openAgentSettings).toContain('setLabsTab("agents")');
    expect(openAgentSettings).toContain('setView("labs")');
  });
});
