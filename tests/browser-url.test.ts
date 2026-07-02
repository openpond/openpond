import { describe, expect, test } from "bun:test";
import { normalizeBrowserUrl } from "../apps/web/src/lib/browser-url";

describe("browser URL normalization", () => {
  test("keeps http and https URLs", () => {
    expect(normalizeBrowserUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(normalizeBrowserUrl("http://localhost:3000/app")).toBe("http://localhost:3000/app");
  });

  test("normalizes localhost and bare domains", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeBrowserUrl("127.0.0.1:3000/login")).toBe("http://127.0.0.1:3000/login");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
  });

  test("allows file URLs only for explicit user actions", () => {
    expect(normalizeBrowserUrl("file:///tmp/report.html")).toBeNull();
    expect(normalizeBrowserUrl("file:///tmp/report.html", { explicitFile: true })).toBe("file:///tmp/report.html");
  });

  test("rejects unsafe or malformed URLs", () => {
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("data:text/html,hello")).toBeNull();
    expect(normalizeBrowserUrl("not a url")).toBeNull();
  });
});
