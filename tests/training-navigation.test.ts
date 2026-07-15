import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarNavigation } from "../apps/web/src/components/sidebar/SidebarNavigation";

describe("Training navigation", () => {
  test("keeps training inside the single Lab destination", () => {
    const html = renderToStaticMarkup(createElement(SidebarNavigation, { beginNewChat: () => undefined, setLabsTab: () => undefined, setSectionMenuOpen: () => undefined, setSelectedAppId: () => undefined, setSelectedProjectId: () => undefined, setSelectedSessionId: () => undefined, setView: () => undefined, view: "labs" }));
    expect(html).toContain("Lab");
    expect(html).not.toContain("Agents");
    expect(html).not.toContain("Training");
    expect(html).not.toContain("Insights");
    expect(html).toContain("nav-profile-command active");
    expect(html).not.toContain("nav-training-command");
    expect(html).not.toContain("training-navigation-rail");
  });
});
