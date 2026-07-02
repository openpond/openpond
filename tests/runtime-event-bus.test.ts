import type { ServerResponse } from "node:http";
import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "@openpond/contracts";

import { createRuntimeEventBus } from "../apps/server/src/runtime/runtime-event-bus";
import type { SqliteStore } from "../apps/server/src/store/store";

describe("runtime event bus assistant delta coalescing", () => {
  test("flushes coalesced assistant deltas before non-delta events", async () => {
    const events: RuntimeEvent[] = [];
    const writes: string[] = [];
    const bus = createRuntimeEventBus({
      logger: testLogger(),
      store: fakeStore(events),
      assistantDeltaFlushMs: 10_000,
    });
    bus.subscribers.add(fakeSubscriber(writes));

    await bus.appendRuntimeEvent(runtimeEvent("delta-1", {
      name: "assistant.delta",
      output: "Hel",
    }));
    await bus.appendRuntimeEvent(runtimeEvent("delta-2", {
      name: "assistant.delta",
      output: "lo",
    }));

    expect(events).toEqual([]);
    expect(writes).toEqual([]);

    await bus.appendRuntimeEvent(runtimeEvent("done", {
      name: "turn.completed",
      status: "completed",
    }));

    expect(events.map((event) => [event.id, event.name, event.output])).toEqual([
      ["delta-1", "assistant.delta", "Hello"],
      ["done", "turn.completed", undefined],
    ]);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('"output":"Hello"');
    expect(writes[1]).toContain('"name":"turn.completed"');
  });

  test("flushes coalesced assistant deltas on the timer when no terminal event follows", async () => {
    const events: RuntimeEvent[] = [];
    const bus = createRuntimeEventBus({
      logger: testLogger(),
      store: fakeStore(events),
      assistantDeltaFlushMs: 5,
    });

    await bus.appendRuntimeEvent(runtimeEvent("delta-1", {
      name: "assistant.delta",
      output: "A",
    }));
    await bus.appendRuntimeEvent(runtimeEvent("delta-2", {
      name: "assistant.delta",
      output: "B",
    }));
    await delay(25);

    expect(events.map((event) => [event.id, event.name, event.output])).toEqual([
      ["delta-1", "assistant.delta", "AB"],
    ]);
  });

  test("compacts large command output before persistence and streaming", async () => {
    const events: RuntimeEvent[] = [];
    const writes: string[] = [];
    const bus = createRuntimeEventBus({
      logger: testLogger(),
      store: fakeStore(events),
      assistantDeltaFlushMs: 10_000,
    });
    bus.subscribers.add(fakeSubscriber(writes));
    const largeOutput = `${"A".repeat(25_000)}middle-content-should-be-omitted${"Z".repeat(25_000)}`;

    await bus.appendRuntimeEvent(runtimeEvent("command-output-1", {
      name: "command.output",
      action: "exec_command",
      output: largeOutput,
      data: { callId: "call-1" },
    }));

    expect(events).toHaveLength(1);
    const stored = events[0]!;
    expect(stored.output?.length).toBeLessThan(largeOutput.length);
    expect(stored.output?.startsWith("A".repeat(1_000))).toBe(true);
    expect(stored.output?.endsWith("Z".repeat(1_000))).toBe(true);
    expect(stored.output).toContain("[openpond event output compacted:");
    expect(stored.output).not.toContain("middle-content-should-be-omitted");
    expect(stored.data).toMatchObject({
      callId: "call-1",
      outputCompaction: {
        schemaVersion: "openpond.runtimeEventOutputCompaction.v1",
        reason: "large_output",
        originalChars: largeOutput.length,
      },
    });

    expect(writes).toHaveLength(1);
    expect(runtimeEventFromSseWrite(writes[0]!).output).toBe(stored.output);
  });
});

function runtimeEvent(
  id: string,
  patch: Partial<RuntimeEvent>,
): RuntimeEvent {
  return {
    id,
    sessionId: "session-1",
    turnId: "turn-1",
    timestamp: `2026-07-01T10:00:0${id.endsWith("2") ? "2" : "1"}.000Z`,
    source: "provider",
    name: "assistant.delta",
    ...patch,
  } as RuntimeEvent;
}

function fakeStore(events: RuntimeEvent[]): SqliteStore {
  return {
    async appendRuntimeEvent(event: RuntimeEvent) {
      events.push(event);
    },
  } as unknown as SqliteStore;
}

function fakeSubscriber(writes: string[]): ServerResponse {
  return {
    destroyed: false,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      return this;
    },
    destroy() {
      return this;
    },
  } as unknown as ServerResponse;
}

function testLogger() {
  return {
    info() {},
    warn() {},
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeEventFromSseWrite(write: string): RuntimeEvent {
  const dataLine = write.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`Missing SSE data line: ${write}`);
  return JSON.parse(dataLine.slice("data: ".length)) as RuntimeEvent;
}
