import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";

import { createRuntimeEventBus } from "../apps/server/src/runtime/runtime-event-bus";
import type { SqliteStore } from "../apps/server/src/store/store";

describe("runtime event bus assistant delta coalescing", () => {
  test("flushes separate answer and reasoning streams before non-delta events", async () => {
    const events: RuntimeEvent[] = [];
    const writes: string[] = [];
    const bus = createRuntimeEventBus({
      logger: testLogger(),
      store: fakeStore(events),
      assistantDeltaFlushMs: 10_000,
    });
    bus.addLiveSubscriber(fakeSubscriber(writes));

    await bus.appendRuntimeEvent(runtimeEvent("delta-1", {
      name: "assistant.delta",
      output: "Hel",
    }));
    await bus.appendRuntimeEvent(runtimeEvent("delta-2", {
      name: "assistant.delta",
      output: "lo",
    }));
    await bus.appendRuntimeEvent(runtimeEvent("reasoning-1", {
      name: "assistant.reasoning.delta",
      output: "Check ",
    }));
    await bus.appendRuntimeEvent(runtimeEvent("reasoning-2", {
      name: "assistant.reasoning.delta",
      output: "inputs",
    }));

    expect(events).toEqual([]);
    expect(writes).toEqual([]);

    await bus.appendRuntimeEvent(runtimeEvent("done", {
      name: "turn.completed",
      status: "completed",
    }));

    expect(events.map((event) => [event.id, event.name, event.output])).toEqual([
      ["delta-1", "assistant.delta", "Hello"],
      ["reasoning-1", "assistant.reasoning.delta", "Check inputs"],
      ["done", "turn.completed", undefined],
    ]);
    expect(writes).toHaveLength(3);
    expect(writes[0]).toContain('"output":"Hello"');
    expect(writes[1]).toContain('"name":"assistant.reasoning.delta"');
    expect(writes[2]).toContain('"name":"turn.completed"');
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

  // Slow remote storage must not let completion overtake a timed write.
  test("waits for in-flight timed persistence before completing a turn", async () => {
    const events: RuntimeEvent[] = [];
    let release!: () => void;
    let acknowledgeStart!: () => void;
    const started = new Promise<void>(resolve => { acknowledgeStart = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bus = createRuntimeEventBus({ logger: testLogger(), assistantDeltaFlushMs: 5,
      store: { async appendRuntimeEvent(event: RuntimeEvent) {
        if (event.name === "assistant.reasoning.delta") { acknowledgeStart(); await gate; }
        const persisted = { ...event, sequence: events.length + 1 };
        events.push(persisted);
        return persisted;
      } } as SqliteStore });
    await bus.appendRuntimeEvent(runtimeEvent("slow-reasoning", { name: "assistant.reasoning.delta", output: "Check inputs" }));
    await started;
    let completed = false;
    const completion = bus.appendRuntimeEvent(runtimeEvent("slow-done", { name: "turn.completed" }))
      .then(() => { completed = true; });
    try {
      await delay(10);
      expect(completed).toBe(false);
      expect(events).toHaveLength(0);
    } finally { release(); }
    await completion;
    expect(events.map(event => [event.name, event.sequence])).toEqual([
      ["assistant.reasoning.delta", 1], ["turn.completed", 2],
    ]);
  });

  // A large provider chunk must be bounded, lossless and backpressure storage.
  test("bounds large streamed chunks and preserves Unicode through slow storage", async () => {
    const events: RuntimeEvent[] = [];
    let release!: () => void;
    let acknowledgeStart!: () => void;
    const started = new Promise<void>(resolve => { acknowledgeStart = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bus = createRuntimeEventBus({ logger: testLogger(), assistantDeltaFlushMs: 5,
      store: { async appendRuntimeEvent(event: RuntimeEvent) {
        if (events.length === 0) { acknowledgeStart(); await gate; }
        const persisted = { ...event, sequence: events.length + 1 };
        events.push(persisted); return persisted;
      } } as SqliteStore });
    const text = `${"A".repeat(4095)}🙂${"B".repeat(9000)}`;
    let returned = false;
    const producer = bus.appendRuntimeEvent(runtimeEvent("large-reasoning", {
      name: "assistant.reasoning.delta", output: text,
    })).then(() => { returned = true; });
    await started;
    try {
      await delay(10);
      expect(returned).toBe(false);
    } finally { release(); }
    await producer;
    await bus.appendRuntimeEvent(runtimeEvent("large-done", { name: "turn.completed" }));
    const chunks = events.filter(event => event.name === "assistant.reasoning.delta");
    expect(chunks.every(event => (event.output?.length ?? 0) <= 4096)).toBe(true);
    expect(chunks.map(event => Buffer.from(event.output ?? "").toString("utf8")).join("")).toBe(text);
    expect(new Set(chunks.map(event => event.id)).size).toBe(chunks.length);
    expect(events.at(-1)?.name).toBe("turn.completed");
  });

  // A failed asynchronous flush must fail the turn, not only emit a warning.
  test("propagates timed persistence failure into completion and shutdown", async () => {
    let acknowledgeStart!: () => void;
    const started = new Promise<void>(resolve => { acknowledgeStart = resolve; });
    const failure = new Error("Retained event storage unavailable");
    const bus = createRuntimeEventBus({ logger: testLogger(), assistantDeltaFlushMs: 5,
      store: { async appendRuntimeEvent() { acknowledgeStart(); throw failure; } } as unknown as SqliteStore });
    bus.addLiveSubscriber(fakeSubscriber([]));
    await bus.appendRuntimeEvent(runtimeEvent("failed-reasoning", { name: "assistant.reasoning.delta", output: "Check inputs" }));
    await started;
    await expect(bus.appendRuntimeEvent(runtimeEvent("failed-done", { name: "turn.completed" }))).rejects.toBe(failure);
    await expect(bus.closeEventSubscribers()).rejects.toBe(failure);
    expect(bus.subscribers.size).toBe(0);
  });

  // A stalled remote writer must slow the producer without concurrent DB floods.
  test("backpressures a sustained stream while storage is stalled", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const events: RuntimeEvent[] = [];
    let active = 0;
    let maximumActive = 0;
    let produced = 0;
    const bus = createRuntimeEventBus({ logger: testLogger(), assistantDeltaFlushMs: 5,
      store: { async appendRuntimeEvent(event: RuntimeEvent) {
        maximumActive = Math.max(maximumActive, ++active);
        await gate;
        const persisted = { ...event, sequence: events.length + 1 };
        events.push(persisted); active -= 1; return persisted;
      } } as SqliteStore });
    const producer = (async () => {
      for (let index = 0; index < 100; index += 1) {
        await bus.appendRuntimeEvent(runtimeEvent(`stream-${index}`, { name: "assistant.reasoning.delta", output: "A" }));
        produced += 1;
        // Chunks keep arriving faster than the flush window; the deadline
        // must stay tied to the first chunk rather than being postponed.
        await delay(2);
      }
    })();
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(maximumActive).toBe(1);
      expect(produced).toBeLessThan(100);
      expect(events).toHaveLength(0);
    } finally {
      release();
      await vi.runAllTimersAsync();
      await producer;
      await bus.closeEventSubscribers();
      vi.useRealTimers();
    }
    expect(events.map(event => event.output).join("")).toBe("A".repeat(100));
  });

  test("compacts large command output before persistence and streaming", async () => {
    const events: RuntimeEvent[] = [];
    const writes: string[] = [];
    const bus = createRuntimeEventBus({
      logger: testLogger(),
      store: fakeStore(events),
      assistantDeltaFlushMs: 10_000,
    });
    bus.addLiveSubscriber(fakeSubscriber(writes));
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

  test("replays sequenced history before marking a subscriber live", async () => {
    const history = [
      { sequence: 4, event: { ...runtimeEvent("history-4", { name: "turn.started" }), sequence: 4 } },
      { sequence: 5, event: { ...runtimeEvent("history-5", { name: "assistant.delta", output: "caught up" }), sequence: 5 } },
    ];
    const writes: string[] = [];
    const store = {
      async appendRuntimeEvent(event: RuntimeEvent) {
        return event;
      },
      async runtimeEventPageRows() {
        return {
          entries: history,
          totalMatchingEvents: history.length,
          remainingMatchingEvents: history.length,
        };
      },
    } as unknown as SqliteStore;
    const bus = createRuntimeEventBus({ logger: testLogger(), store });

    const close = await bus.openEventSubscriber({
      response: fakeSubscriber(writes),
      afterSequence: 3,
      sessionId: "session-1",
    });
    close();

    expect(writes.map(runtimeEventFromSseWrite).map((event) => event.sequence)).toEqual([4, 5]);
    expect(writes[0]?.startsWith("id: 4\n")).toBe(true);
  });

  test("queues subscriber events during stream backpressure and flushes them on drain", async () => {
    const events: RuntimeEvent[] = [];
    let destroyed = false;
    let backpressured = true;
    const writes: string[] = [];
    const bus = createRuntimeEventBus({ logger: testLogger(), store: fakeStore(events) });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      write(chunk: string) {
        writes.push(chunk);
        if (!backpressured) return true;
        backpressured = false;
        return false;
      },
      destroy() {
        destroyed = true;
        this.destroyed = true;
        return this;
      },
    }) as unknown as ServerResponse;
    bus.addLiveSubscriber(response);

    await bus.appendRuntimeEvent(runtimeEvent("slow-client-1", { name: "turn.started" }));
    await bus.appendRuntimeEvent(runtimeEvent("slow-client-2", { name: "turn.completed" }));

    expect(destroyed).toBe(false);
    expect(bus.subscribers.size).toBe(1);
    expect(writes.map(runtimeEventFromSseWrite).map((event) => event.id)).toEqual([
      "slow-client-1",
    ]);

    response.emit("drain");

    expect(writes.map(runtimeEventFromSseWrite).map((event) => event.id)).toEqual([
      "slow-client-1",
      "slow-client-2",
    ]);
    expect(destroyed).toBe(false);
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
      const persisted = { ...event, sequence: events.length + 1 };
      events.push(persisted);
      return persisted;
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
