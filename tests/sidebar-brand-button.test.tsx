import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SidebarExperienceMenu,
} from "../apps/web/src/components/sidebar/SidebarExperienceMenu";
import { EXPERIENCE_OPTIONS } from "../apps/web/src/lib/experience-options";

describe("Sidebar experience wordmark", () => {
  test("renders the selected experience in the accessible wordmark trigger", () => {
    const markup = renderToStaticMarkup(
      <SidebarExperienceMenu value="work" onChange={() => undefined} />
    );

    expect(markup).toContain(
      'class="sidebar-wordmark-button sidebar-experience-trigger"'
    );
    expect(markup).toContain('aria-label="OpenPond experience: Work"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('src="./openpond-wordlogo-white.png" alt=""');
    expect(markup).toContain(
      '<span class="sidebar-experience-label">Work</span>'
    );
    expect(EXPERIENCE_OPTIONS.map((option) => option.value)).toEqual([
      "chat",
      "work",
      "development",
    ]);
  });

  test("places the experience wordmark in the sidebar toggle toolbar", async () => {
    const source = await readFile(
      "apps/web/src/components/sidebar/Sidebar.tsx",
      "utf8"
    );
    const toolbarStart = source.indexOf('<div className="sidebar-toolbar">');
    const navigationStart = source.indexOf("<SidebarNavigation");
    const brand = source.indexOf("<SidebarExperienceMenu", toolbarStart);

    expect(toolbarStart).toBeGreaterThan(-1);
    expect(brand).toBeGreaterThan(toolbarStart);
    expect(brand).toBeLessThan(navigationStart);
    expect(source).not.toContain("<SidebarBrandButton");
  });
});
