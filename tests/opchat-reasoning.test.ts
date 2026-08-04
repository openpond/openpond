import { describe, expect, test } from "vitest";
import { opChatReasoningFields } from "../packages/runtime/src/chat.js";

describe("OpChat reasoning fields", () => {
  test.each([
    [null, {}],
    ["low", { thinking: { type: "disabled" } }],
    [
      "medium",
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    ],
    [
      "high",
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    ],
    [
      "xhigh",
      { thinking: { type: "enabled" }, reasoning_effort: "max" },
    ],
  ] as const)("maps %s to the supported OpChat request", (effort, expected) => {
    expect(opChatReasoningFields(effort)).toEqual(expected);
  });
});
