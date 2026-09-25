import type { RuntimeEvent } from "@openpond/contracts";
import { describe } from "vitest";

describe("runtime event list merging", () => {
});

function runtimeEvent(
  id: string,
  sequence?: number,
  overrides: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    id,
    sequence,
    sessionId: "session_1",
    name: "turn.started",
    timestamp: "2026-07-01T10:00:00.000Z",
    source: "server",
    ...overrides,
  };
}
