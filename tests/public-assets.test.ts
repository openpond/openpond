import { describe, expect, test } from "vitest";

import {
  connectedAppIconUrl,
  OPENPOND_ICON_URL,
  OPENPOND_WORDMARK_WHITE_URL,
  publicAssetUrl,
  TOKEN_ICON_URLS,
} from "../apps/web/src/lib/public-assets";

describe("web public asset URLs", () => {
  test("resolve beside the packaged renderer instead of the filesystem root", () => {
    const rendererUrl = "file:///Applications/openpond.app/Contents/Resources/web/index.html";
    const assetUrls = [
      OPENPOND_ICON_URL,
      OPENPOND_WORDMARK_WHITE_URL,
      connectedAppIconUrl("github"),
      TOKEN_ICON_URLS.ETH,
    ];

    for (const assetUrl of assetUrls) {
      expect(assetUrl.startsWith("./")).toBe(true);
      expect(new URL(assetUrl, rendererUrl).pathname.startsWith(
        "/Applications/openpond.app/Contents/Resources/web/",
      )).toBe(true);
    }
  });

  test("normalizes callers that pass a leading slash", () => {
    expect(publicAssetUrl("/openpond-icon.png")).toBe("./openpond-icon.png");
    expect(publicAssetUrl("./openpond-icon.png")).toBe("./openpond-icon.png");
  });
});
