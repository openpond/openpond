import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsNavigation } from "../apps/web/src/components/settings/SettingsNavigation";

describe("SettingsNavigation", () => {
  test("places Notifications near the top without shouting the label", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "notifications",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );

    expect(markup.indexOf("Account")).toBeLessThan(markup.indexOf("Notifications"));
    expect(markup.indexOf("Notifications")).toBeLessThan(markup.indexOf("Providers"));
    expect(markup).toContain('class="settings-nav-item active"');
    expect(markup).not.toContain("NOTIFICATIONS");
  });

  test("shows usage in the top settings group", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "usage",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );

    expect(markup.indexOf("Wallet")).toBeLessThan(markup.indexOf("Activity"));
    expect(markup.indexOf("Activity")).toBeLessThan(markup.indexOf("Defaults"));
    expect(markup.indexOf("Activity")).toBeLessThan(markup.indexOf("Harness"));
  });

  test("shows providers in the top settings group", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "providers",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );

    expect(markup.indexOf("Notifications")).toBeLessThan(markup.indexOf("Providers"));
    expect(markup.indexOf("Providers")).toBeLessThan(markup.indexOf("Wallet"));
    expect(markup.indexOf("Providers")).toBeLessThan(markup.indexOf("Harness"));
  });

  test("starts the Harness section with My Profile and native Skills", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "skills",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );

    expect(markup.indexOf("Harness")).toBeLessThan(markup.indexOf("My Profile"));
    expect(markup.indexOf("My Profile")).toBeLessThan(markup.indexOf("Skills"));
    expect(markup.indexOf("Skills")).toBeLessThan(markup.indexOf("Goals"));
    expect(markup).toContain("My Profile");
    expect(markup).not.toContain("<span>Profile</span>");
    expect(markup).toContain('class="settings-nav-item active"');
  });

  test("places Dataset Storage directly below Compute", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "dataset-storage",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );

    expect(markup.indexOf("Compute")).toBeLessThan(
      markup.indexOf("Dataset Storage"),
    );
    expect(markup.indexOf("Dataset Storage")).toBeLessThan(
      markup.indexOf("Wallet"),
    );
    expect(markup).toContain('class="settings-nav-item active"');
  });

  test("places Training with the other harness controls", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsNavigation, {
        section: "training",
        onBack: () => undefined,
        onSectionChange: () => undefined,
      }),
    );
    expect(markup.indexOf("Insights")).toBeLessThan(markup.indexOf("Training"));
    expect(markup.indexOf("Training")).toBeLessThan(markup.indexOf("Subagents"));
    expect(markup).toContain('class="settings-nav-item active"');
  });
});
