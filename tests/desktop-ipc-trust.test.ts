import { describe, expect, test } from "bun:test";
import { isTrustedDesktopIpcFrameUrl } from "../apps/desktop/src/desktop-ipc-trust";

describe("desktop IPC origin trust", () => {
  test("accepts only the configured development origin", () => {
    const base = {
      packaged: false,
      trustedRendererUrl: "http://127.0.0.1:17876/",
    };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://127.0.0.1:17876/chat#one" })).toBe(true);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://localhost:17876/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "https://example.com/" })).toBe(false);
  });

  test("accepts only the configured packaged loopback origin", () => {
    const base = { packaged: true, trustedRendererUrl: "http://127.0.0.1:17874/" };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://127.0.0.1:17874/chat#one" })).toBe(true);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://localhost:17874/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "http://127.0.0.1:17875/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "https://127.0.0.1:17874/chat" })).toBe(false);
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "file:///opt/openpond/resources/web/index.html" })).toBe(false);
  });

  test("rejects a non-loopback renderer even when its origin matches", () => {
    const base = { packaged: true, trustedRendererUrl: "https://example.com/" };
    expect(isTrustedDesktopIpcFrameUrl({ ...base, frameUrl: "https://example.com/chat" })).toBe(false);
  });
});
