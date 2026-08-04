import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarNavigation } from "../apps/web/src/components/sidebar/SidebarNavigation";

describe("Training navigation", () => {
  test("keeps training inside the Models destination", () => {
    const html = renderToStaticMarkup(createElement(SidebarNavigation, { beginNewChat: () => undefined, productArea: "models", setSectionMenuOpen: () => undefined, setSelectedAppId: () => undefined, setSelectedProjectId: () => undefined, setSelectedSessionId: () => undefined, setView: () => undefined, view: "labs" }));
    expect(html).toContain("Models");
    expect(html).toContain("Tasksets");
    expect(html).toContain("Serving");
    expect(html).toContain("Usage");
    expect(html).not.toContain("Profile");
    expect(html).not.toContain("Agents");
    expect(html).not.toContain("Training");
    expect(html).not.toContain("Insights");
    expect(html).toContain('class="nav-command active" aria-label="Models"');
    expect(html).not.toContain("nav-training-command");
    expect(html).not.toContain("training-navigation-rail");
  });
});
