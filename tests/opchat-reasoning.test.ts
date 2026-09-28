import { describe, expect, test } from "vitest";
import { opChatReasoningFields } from "../packages/runtime/src/chat.js";

describe("OpChat reasoning fields", () => {
  test.each([
    [null, {}],
    ["off", { thinking: { type: "disabled" } }],
    [
      "low",
      { thinking: { type: "enabled" }, reasoning_effort: "low" },
    ],
    [
      "medium",
      { thinking: { type: "enabled" }, reasoning_effort: "medium" },
    ],
    [
      "high",
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    ],
    [
      "xhigh",
      { thinking: { type: "enabled" }, reasoning_effort: "xhigh" },
    ],
    [
      "max",
      { thinking: { type: "enabled" }, reasoning_effort: "max" },
    ],
  ] as const)("maps %s to the supported OpChat request", (effort, expected) => {
    expect(opChatReasoningFields(effort)).toEqual(expected);
  });
});
