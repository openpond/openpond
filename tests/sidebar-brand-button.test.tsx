import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarBrandButton } from "../apps/web/src/components/sidebar/SidebarBrandButton";

describe("Sidebar brand button", () => {
  test("renders the wordmark as an accessible home button", () => {
    const markup = renderToStaticMarkup(<SidebarBrandButton onOpenHome={() => undefined} />);

    expect(markup).toContain('<button type="button" class="sidebar-wordmark-button" aria-label="OpenPond home">');
    expect(markup).toContain('src="/openpond-wordlogo-white.png" alt=""');
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
});
