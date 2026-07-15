import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppSplash } from "../apps/web/src/components/splash/AppSplash";
import { startupSplashRemainingMs } from "../apps/web/src/hooks/useAppBootstrap";
import { appStartupState } from "../apps/web/src/startup/app-startup";

describe("app startup splash timing", () => {
  test("keeps only a short floor for very fast bootstraps", () => {
    expect(startupSplashRemainingMs(0)).toBe(650);
    expect(startupSplashRemainingMs(400)).toBe(250);
    expect(startupSplashRemainingMs(650)).toBe(0);
  });

  test("does not hold the splash after normal or slow successful bootstrap", () => {
    expect(startupSplashRemainingMs(1200)).toBe(0);
    expect(startupSplashRemainingMs(3200)).toBe(0);
  });

  test("loads the logo relative to the packaged renderer", () => {
    const markup = renderToStaticMarkup(
      createElement(AppSplash, { startup: appStartupState("connecting") }),
    );

    expect(markup).toContain('src="./openpond-icon.png"');
  });
});
