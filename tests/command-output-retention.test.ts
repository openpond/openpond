import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import {
  MAX_PROJECTED_COMMAND_OUTPUT_CHARS,
  boundProjectedCommandOutput,
} from "../apps/web/src/lib/chat-activities";

describe("projected command output retention", () => {
  test("keeps a bounded head and tail with a history recovery marker", () => {
    const value = `HEAD:${"a".repeat(80_000)}:TAIL`;
    const bounded = boundProjectedCommandOutput(value);

    expect(bounded.length).toBeLessThanOrEqual(MAX_PROJECTED_COMMAND_OUTPUT_CHARS);
    expect(bounded).toContain("HEAD:");
    expect(bounded).toContain(":TAIL");
    expect(bounded).toContain("full output remains in task history");
  });

  test("bounds the renderer projection while leaving durable runtime events intact", () => {
    const output = `start-${"x".repeat(90_000)}-end`;
    const events = [
      event("start", "turn.started", { args: { prompt: "Run it" } }),
      event("tool", "tool.started", {
        action: "exec_command",
        data: { command: "pnpm test", callId: "call-1" },
      }),
      event("output", "command.output", {
        output,
        data: { callId: "call-1" },
      }),
      event("complete", "tool.completed", {
        action: "exec_command",
        data: { command: "pnpm test", callId: "call-1" },
      }),
    ];

    const messages = buildChatMessages(events);
    const detail = messages
      .flatMap((message) => message.activities ?? [])
      .find((activity) => activity.kind === "command")?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(MAX_PROJECTED_COMMAND_OUTPUT_CHARS);
    expect(events[2]?.output).toBe(output);
    expect(events[2]?.output?.length).toBeGreaterThan(MAX_PROJECTED_COMMAND_OUTPUT_CHARS);
  });
});

function event(id: string, name: string, extra: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id,
    name,
    sessionId: "session-1",
    turnId: "turn-1",
    timestamp: "2026-08-20T00:00:00.000Z",
    source: "provider",
    ...extra,
  } as RuntimeEvent;
}
