import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import { isTrustedDesktopIpcFrameUrl } from "../apps/desktop/src/desktop-ipc-trust";

describe("desktop IPC origin trust", () => {
  test("accepts only the configured development origin", () => {
    const base = {
      packaged: false,
      resourcesPath: "/opt/openpond/resources",
      trustedRendererUrl: "http://127.0.0.1:17876/",
    };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://127.0.0.1:17876/chat#one" })).toBe(true);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://localhost:17876/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "https://example.com/" })).toBe(false);
  });

  test("accepts only the packaged renderer entry file", () => {
    const resourcesPath = "/opt/openpond/resources";
    const entry = path.join(resourcesPath, "web", "index.html");
    const base = { packaged: true, resourcesPath, trustedRendererUrl: pathToFileURL(entry).toString() };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: pathToFileURL(entry).toString() })).toBe(true);
    expect(isTrustedDesktopIpcFrameUrl({
      ...base,
      frameUrl: pathToFileURL(path.join(resourcesPath, "web", "other.html")).toString(),
    })).toBe(false);
  });
});
