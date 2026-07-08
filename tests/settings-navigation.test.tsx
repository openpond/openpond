import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsNavigation } from "../apps/web/src/components/settings/SettingsNavigation";

describe("SettingsNavigation", () => {
  test("shows usage in the top settings group", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "usage",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );

    expect(markup.indexOf("Wallet")).toBeLessThan(markup.indexOf("Usage"));
    expect(markup.indexOf("Usage")).toBeLessThan(markup.indexOf("Defaults"));
    expect(markup.indexOf("Usage")).toBeLessThan(markup.indexOf("Harness"));
  });

  test("shows providers directly below profile", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "providers",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );

    expect(markup.indexOf("Profile")).toBeLessThan(markup.indexOf("Providers"));
    expect(markup.indexOf("Providers")).toBeLessThan(markup.indexOf("Wallet"));
    expect(markup.indexOf("Providers")).toBeLessThan(markup.indexOf("Harness"));
  });
});
