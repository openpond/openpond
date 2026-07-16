import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarBrandButton } from "../apps/web/src/components/sidebar/SidebarBrandButton";

describe("Sidebar brand button", () => {
  test("renders the wordmark as an accessible home button", () => {
    const markup = renderToStaticMarkup(<SidebarBrandButton onOpenHome={() => undefined} />);

    expect(markup).toContain('<button type="button" class="sidebar-wordmark-button" aria-label="OpenPond home">');
    expect(markup).toContain('src="./openpond-wordlogo-white.png" alt=""');
  });

  test("opens home when activated", () => {
    let activationCount = 0;
    const button = SidebarBrandButton({
      onOpenHome: () => {
        activationCount += 1;
      },
    });

    button.props.onClick();

    expect(activationCount).toBe(1);
  });

  test("places the wordmark in the sidebar toggle toolbar", async () => {
    const source = await readFile("apps/web/src/components/sidebar/Sidebar.tsx", "utf8");
    const toolbarStart = source.indexOf('<div className="sidebar-toolbar">');
    const navigationStart = source.indexOf("<SidebarNavigation");
    const brand = source.indexOf("<SidebarBrandButton", toolbarStart);

    expect(toolbarStart).toBeGreaterThan(-1);
    expect(brand).toBeGreaterThan(toolbarStart);
    expect(brand).toBeLessThan(navigationStart);
    expect(source).not.toContain("sidebar-wordmark-row");
  });
});
