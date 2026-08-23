import { describe, expect, test } from "vitest";
import {
  isAllowedExternalDesktopUrl,
  isTrustedDesktopNavigationUrl,
} from "../apps/desktop/src/desktop-navigation-policy";

describe("desktop navigation policy", () => {
  test("allows ordinary web and email destinations", () => {
    expect(isAllowedExternalDesktopUrl("https://openpond.ai/docs")).toBe(true);
    expect(isAllowedExternalDesktopUrl("http://127.0.0.1:3000/preview")).toBe(true);
    expect(isAllowedExternalDesktopUrl("mailto:support@openpond.ai")).toBe(true);
  });

  test("rejects executable, local-file, credential-bearing, and malformed destinations", () => {
    expect(isAllowedExternalDesktopUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalDesktopUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalDesktopUrl("data:text/html,hello")).toBe(false);
    expect(isAllowedExternalDesktopUrl("https://user:secret@example.com/")).toBe(false);
    expect(isAllowedExternalDesktopUrl("mailto:")).toBe(false);
    expect(isAllowedExternalDesktopUrl("not a url")).toBe(false);
  });

  test("keeps main-frame navigation on the configured renderer origin", () => {
    const base = {
      packaged: false,
      trustedRendererUrl: "http://127.0.0.1:17876/",
    };
    expect(isTrustedDesktopNavigationUrl({
      ...base,
      navigationUrl: "http://127.0.0.1:17876/settings#skills",
    })).toBe(true);
    expect(isTrustedDesktopNavigationUrl({
      ...base,
      navigationUrl: "https://openpond.ai/",
    })).toBe(false);
    expect(isTrustedDesktopNavigationUrl({
      ...base,
      navigationUrl: "http://localhost:17876/",
    })).toBe(false);
  });
});
