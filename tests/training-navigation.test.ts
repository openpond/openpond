import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarNavigation } from "../apps/web/src/components/sidebar/SidebarNavigation";

describe("Training navigation", () => {
  test("places Training as a top-level destination immediately after Agents", () => {
    const html = renderToStaticMarkup(createElement(SidebarNavigation, { beginNewChat: () => undefined, profileHasUncommittedChanges: false, setSectionMenuOpen: () => undefined, setSelectedAppId: () => undefined, setSelectedProjectId: () => undefined, setSelectedSessionId: () => undefined, setView: () => undefined, view: "training" }));
    expect(html.indexOf("Agents")).toBeLessThan(html.indexOf("Training"));
    expect(html).toContain('class="nav-command active"');
    expect(html).not.toContain("nav-training-command");
    expect(html).not.toContain("training-navigation-rail");
  });
});
