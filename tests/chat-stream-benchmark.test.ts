import { describe, expect, test } from "vitest";
import { runChatStreamBenchmark } from "../scripts/benchmark-chat-stream";

describe("chat stream benchmark fixture", () => {
  test("measures legacy merge, scoped storage, transport, projection, and retained heap", () => {
    const report = runChatStreamBenchmark({
      sessionCount: 3,
      eventsPerSession: 120,
      batchSize: 16,
    });

    expect(report.fixture).toMatchObject({
      sessions: 3,
      eventsPerSession: 120,
      totalEvents: 360,
      batchSize: 16,
    });
    expect(report.merge.iterations).toBeGreaterThan(1);
    expect(report.merge.retainedEvents).toBeGreaterThan(0);
    expect(report.sessionStore.retainedEvents).toBe(report.fixture.totalEvents);
    expect(report.sessionStore.retainedSessions).toBe(report.fixture.sessions);
    expect(report.sessionStore.unaffectedSnapshotStable).toBe(true);
    expect(report.capSlide.iterations).toBe(200);
    expect(report.indexes.indexedSessions).toBeGreaterThan(0);
    expect(report.projection.messages).toBeGreaterThan(0);
    expect(report.incrementalProjection.batchesPerIteration).toBeGreaterThan(1);
    expect(report.incrementalProjection.messages).toBe(report.projection.messages);
    expect(report.transport.serializedBytes).toBeGreaterThan(0);
    expect(report.transport.averageBytesPerSession).toBeGreaterThan(0);
    expect(Number.isFinite(report.retainedHeap.deltaBytes)).toBe(true);
  });
});
