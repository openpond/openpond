import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { RuntimeEvent } from "@openpond/contracts";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import { IncrementalChatProjector } from "../apps/web/src/lib/incremental-chat-projector";
import {
  MAX_LIVE_RUNTIME_EVENTS,
  mergeLiveRuntimeEventLists,
} from "../apps/web/src/lib/runtime-event-lists";
import { buildRuntimeIndexes } from "../apps/web/src/lib/runtime-indexes";
import { RuntimeEventStore } from "../apps/web/src/lib/runtime-event-store";

const DEFAULT_SESSION_COUNT = 4;
const DEFAULT_EVENTS_PER_SESSION = 5_000;
const DEFAULT_BATCH_SIZE = 32;

export type ChatStreamBenchmarkReport = {
  generatedAt: string;
  fixture: {
    sessions: number;
    eventsPerSession: number;
    totalEvents: number;
    batchSize: number;
    liveEventLimit: number;
  };
  merge: BenchmarkMeasurement & {
    retainedEvents: number;
  };
  sessionStore: BenchmarkMeasurement & {
    retainedEvents: number;
    retainedSessions: number;
    unaffectedSnapshotStable: boolean;
  };
  capSlide: BenchmarkMeasurement;
  indexes: BenchmarkMeasurement & {
    indexedSessions: number;
  };
  projection: BenchmarkMeasurement & {
    messages: number;
  };
  incrementalProjection: BenchmarkMeasurement & {
    batchesPerIteration: number;
    messages: number;
  };
  transport: {
    serializedBytes: number;
    averageBytesPerEvent: number;
    averageBytesPerSession: number;
  };
  retainedHeap: {
    beforeBytes: number;
    afterBytes: number;
    deltaBytes: number;
    garbageCollectionAvailable: boolean;
  };
};

type BenchmarkMeasurement = {
  iterations: number;
  totalMs: number;
  averageMs: number;
};

export function runChatStreamBenchmark(input: {
  sessionCount?: number;
  eventsPerSession?: number;
  batchSize?: number;
} = {}): ChatStreamBenchmarkReport {
  const sessionCount = input.sessionCount ?? DEFAULT_SESSION_COUNT;
  const eventsPerSession = input.eventsPerSession ?? DEFAULT_EVENTS_PER_SESSION;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const events = mixedRuntimeEvents(sessionCount, eventsPerSession);

  collectGarbage();
  const heapBefore = process.memoryUsage().heapUsed;

  let liveEvents: RuntimeEvent[] = [];
  const mergeStartedAt = performance.now();
  let mergeIterations = 0;
  for (let index = 0; index < events.length; index += batchSize) {
    liveEvents = mergeLiveRuntimeEventLists(
      liveEvents,
      events.slice(index, index + batchSize),
    );
    mergeIterations += 1;
  }
  const mergeTotalMs = performance.now() - mergeStartedAt;

  const sessionStore = new RuntimeEventStore({
    perSessionLimit: eventsPerSession,
    totalLimit: Math.max(eventsPerSession, events.length),
  });
  const sessionStoreStartedAt = performance.now();
  let sessionStoreIterations = 0;
  for (let index = 0; index < events.length; index += batchSize) {
    sessionStore.append(events.slice(index, index + batchSize));
    sessionStoreIterations += 1;
  }
  const sessionStoreTotalMs = performance.now() - sessionStoreStartedAt;
  const isolationProbe = new RuntimeEventStore({
    perSessionLimit: eventsPerSession + 1,
    totalLimit: Math.max(eventsPerSession + 1, events.length + 1),
  });
  isolationProbe.append(events);
  const unaffectedSnapshot = isolationProbe.getSessionSnapshot("benchmark-session-1");
  isolationProbe.append([
    benchmarkEvent({
      eventIndex: eventsPerSession,
      sequence: events.length + 1,
      sessionIndex: 0,
    }),
  ]);
  const unaffectedSnapshotStable =
    isolationProbe.getSessionSnapshot("benchmark-session-1") === unaffectedSnapshot;

  const capSlideBatch = mixedRuntimeEvents(1, batchSize, events.length);
  const capSlide = measure(200, () => {
    liveEvents = mergeLiveRuntimeEventLists(liveEvents, capSlideBatch);
  });

  let indexes = buildRuntimeIndexes(liveEvents, []);
  const indexMeasurement = measure(100, () => {
    indexes = buildRuntimeIndexes(liveEvents, []);
  });

  const projectionEvents = mixedRuntimeEvents(1, eventsPerSession);
  let messages = buildChatMessages(projectionEvents);
  const projectionMeasurement = measure(100, () => {
    messages = buildChatMessages(projectionEvents);
  });
  const incrementalIterations = 20;
  const batchesPerIteration = Math.ceil(projectionEvents.length / batchSize);
  let incrementalMessages = messages;
  const incrementalStartedAt = performance.now();
  for (let iteration = 0; iteration < incrementalIterations; iteration += 1) {
    const projector = new IncrementalChatProjector();
    for (let end = batchSize; end < projectionEvents.length; end += batchSize) {
      incrementalMessages = projector.project(projectionEvents.slice(0, end));
    }
    incrementalMessages = projector.project(projectionEvents);
  }
  const incrementalTotalMs = performance.now() - incrementalStartedAt;

  collectGarbage();
  const heapAfter = process.memoryUsage().heapUsed;
  const serializedBytes = Buffer.byteLength(JSON.stringify(events), "utf8");
  const sessionStoreStats = sessionStore.getStats();

  return {
    generatedAt: new Date().toISOString(),
    fixture: {
      sessions: sessionCount,
      eventsPerSession,
      totalEvents: events.length,
      batchSize,
      liveEventLimit: MAX_LIVE_RUNTIME_EVENTS,
    },
    merge: {
      iterations: mergeIterations,
      totalMs: round(mergeTotalMs),
      averageMs: round(mergeTotalMs / Math.max(1, mergeIterations)),
      retainedEvents: liveEvents.length,
    },
    sessionStore: {
      iterations: sessionStoreIterations,
      totalMs: round(sessionStoreTotalMs),
      averageMs: round(sessionStoreTotalMs / Math.max(1, sessionStoreIterations)),
      retainedEvents: sessionStoreStats.eventCount,
      retainedSessions: sessionStoreStats.sessionCount,
      unaffectedSnapshotStable,
    },
    capSlide,
    indexes: {
      ...indexMeasurement,
      indexedSessions: indexes.eventsBySessionId.size,
    },
    projection: {
      ...projectionMeasurement,
      messages: messages.length,
    },
    incrementalProjection: {
      iterations: incrementalIterations,
      batchesPerIteration,
      totalMs: round(incrementalTotalMs),
      averageMs: round(incrementalTotalMs / (incrementalIterations * batchesPerIteration)),
      messages: incrementalMessages.length,
    },
    transport: {
      serializedBytes,
      averageBytesPerEvent: round(serializedBytes / Math.max(1, events.length)),
      averageBytesPerSession: round(serializedBytes / Math.max(1, sessionCount)),
    },
    retainedHeap: {
      beforeBytes: heapBefore,
      afterBytes: heapAfter,
      deltaBytes: heapAfter - heapBefore,
      garbageCollectionAvailable: typeof global.gc === "function",
    },
  };
}

function measure(iterations: number, callback: () => void): BenchmarkMeasurement {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) callback();
  const totalMs = performance.now() - startedAt;
  return {
    iterations,
    totalMs: round(totalMs),
    averageMs: round(totalMs / iterations),
  };
}

function mixedRuntimeEvents(
  sessionCount: number,
  eventsPerSession: number,
  sequenceOffset = 0,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (let eventIndex = 0; eventIndex < eventsPerSession; eventIndex += 1) {
    for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
      events.push(benchmarkEvent({
        eventIndex,
        sequence: sequenceOffset + eventIndex * sessionCount + sessionIndex + 1,
        sessionIndex,
      }));
    }
  }
  return events;
}

function benchmarkEvent(input: {
  eventIndex: number;
  sequence: number;
  sessionIndex: number;
}): RuntimeEvent {
  const { eventIndex, sequence, sessionIndex } = input;
  const sessionId = `benchmark-session-${sessionIndex}`;
  const turnId = `${sessionId}-turn-${Math.floor(eventIndex / 200)}`;
  const pattern = eventIndex % 10;
  return {
    id: `benchmark-event-${sequence}`,
    sequence,
    sessionId,
    turnId,
    timestamp: new Date(1_750_000_000_000 + sequence).toISOString(),
    source: "provider",
    name:
      pattern === 0
        ? "turn.started"
        : pattern === 1 || pattern === 2
          ? "assistant.reasoning.delta"
          : pattern === 3
            ? "command.started"
            : pattern === 4 || pattern === 5
              ? "command.output"
              : pattern === 9
                ? "turn.completed"
                : "assistant.delta",
    args: pattern === 0 ? { prompt: `Benchmark prompt ${eventIndex}` } : undefined,
    output:
      pattern === 1 || pattern === 2
        ? "reasoning chunk "
        : pattern === 4 || pattern === 5
          ? "command output line\n"
          : pattern >= 6 && pattern <= 8
            ? "assistant response chunk "
            : undefined,
    data:
      pattern === 3
        ? { command: "pnpm test", commandId: `command-${turnId}` }
        : undefined,
  } as RuntimeEvent;
}

function collectGarbage(): void {
  if (typeof global.gc === "function") global.gc();
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function main(): Promise<void> {
  const outputIndex = process.argv.findIndex((argument) => argument === "--json");
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const report = runChatStreamBenchmark();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
