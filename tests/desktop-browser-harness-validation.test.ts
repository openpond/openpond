import { describe, expect, test } from "vitest";
import { parseBrowserHarnessRequest } from "../apps/desktop/src/desktop-browser-harness-validation";

describe("desktop browser harness validation", () => {
  test("parses valid browser queue requests", () => {
    expect(parseBrowserHarnessRequest(request("open", "openpond_browser_open", {
      ...baseInput(),
      url: "https://example.test",
    }))).toMatchObject({
      operation: "open",
      toolName: "openpond_browser_open",
      input: {
        conversationId: "conversation_1",
        url: "https://example.test",
      },
    });

    expect(parseBrowserHarnessRequest(request("click", "openpond_browser_click", {
      ...baseInput(),
      snapshotId: "browser_snap_1",
      targetRef: "ref_1",
      button: "right",
      clickCount: 2,
    }))).toMatchObject({
      operation: "click",
      input: {
        target: { kind: "ref", snapshotId: "browser_snap_1", targetRef: "ref_1" },
        button: "right",
        clickCount: 2,
      },
    });

    expect(parseBrowserHarnessRequest(request("scroll", "openpond_browser_scroll", {
      ...baseInput(),
      x: 120,
      y: 240,
      deltaY: 300,
    }))).toMatchObject({
      operation: "scroll",
      input: {
        target: { kind: "point", point: { x: 120, y: 240 } },
        deltaX: 0,
        deltaY: 300,
      },
    });
  });

  test("rejects malformed browser queue requests", () => {
    expect(() => parseBrowserHarnessRequest(request("open", "openpond_browser_click", baseInput()))).toThrow(
      "Browser operation and tool name do not match.",
    );
    expect(() => parseBrowserHarnessRequest(request("click", "openpond_browser_click", {
      ...baseInput(),
      targetRef: "ref_without_snapshot",
    }))).toThrow("targetRef requires snapshotId.");
    expect(() => parseBrowserHarnessRequest(request("scroll", "openpond_browser_scroll", {
      ...baseInput(),
      deltaY: 5000,
    }))).toThrow("deltaY must be between -4000 and 4000.");
    expect(() => parseBrowserHarnessRequest(request("pressKey", "openpond_browser_key", {
      ...baseInput(),
      key: "F12",
    }))).toThrow("key must be one of:");
  });
});

function request(operation: string, toolName: string, input: Record<string, unknown>) {
  return {
    id: "browser_req_1",
    operation,
    toolName,
    createdAt: "2026-07-04T12:00:00.000Z",
    deadlineAt: "2026-07-04T12:00:30.000Z",
    input,
  };
}

function baseInput() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    conversationId: "conversation_1",
    callId: "call_1",
  };
}
