import { describe, expect, test } from "vitest";
import { IncrementalChatProjector } from "../apps/web/src/lib/incremental-chat-projector";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  latestRuntimeEventSequence,
  MAX_LIVE_RUNTIME_EVENTS,
  mergeBootstrapRuntimeEvents,
  mergeLiveRuntimeEventLists,
  mergeRuntimeEventsIntoSessionPageCache,
  mergeRuntimeEventLists,
} from "../apps/web/src/lib/runtime-event-lists";

describe("runtime event list merging", () => {
  test("dedupes events while preserving first-list precedence", () => {
    const first = [runtimeEvent("one", 1), runtimeEvent("two", 2, { output: "from bootstrap" })];
    const second = [runtimeEvent("two", undefined, { output: "from stream" }), runtimeEvent("three")];

    expect(mergeRuntimeEventLists(first, second)).toEqual([
      first[0],
      first[1],
      second[1],
    ]);
  });

  // Loading a newer page over a fuller live window must not move the old
  // turn start behind its publication or the subsequent selection response.
  test("replays overlapping history windows in durable sequence order", () => {
    const visual = {
      visualId: `visual_${"a".repeat(32)}`, publicationId: `visual_pub_${"b".repeat(32)}`,
      sessionId: "session_1", turnId: "picker", heights: [{ width: 680, height: 200 }],
      output: { id: "output", title: "Dataset picker", sourceTaskId: "session_1", sourceTurnId: "picker",
        revision: 1, createdAt: "2026-07-01T10:00:00.000Z", kind: "file", contentType: "text/html",
        sizeBytes: 100, sha256: "c".repeat(64), validation: [],
        location: { kind: "managed", fileId: "file", downloadPath: "/visual.html" } },
    };
    const live = [
      runtimeEvent("picker-start", 10, { turnId: "picker", args: { prompt: "List datasets" } }),
      runtimeEvent("published-picker", 11, { turnId: "picker", name: "visual.published", data: { visual } }),
      runtimeEvent("picker-complete", 12, { turnId: "picker", name: "turn.completed" }),
    ];
    const newerPage = [live[1]!, live[2]!,
      runtimeEvent("selection-start", 13, { turnId: "selection", args: { prompt: "Selected dataset" } }),
      runtimeEvent("selection-answer", 14, { turnId: "selection", name: "assistant.delta", output: "Selected" }),
    ];
    const merged = mergeRuntimeEventLists(newerPage, live);
    expect(merged.map(event => event.id)).toEqual([
      "picker-start", "published-picker", "picker-complete", "selection-start", "selection-answer",
    ]);
    expect(mergeRuntimeEventLists(live, newerPage)).toEqual(merged);
    const projector = new IncrementalChatProjector();
    projector.project(live);
    const projected = projector.project(merged);
    expect(projected).toEqual(buildChatMessages([...live, ...newerPage.slice(2)]));
    expect(projected.filter(message => message.role === "visual")).toMatchObject([{ visual }]);
  });

  test("preserves the live transcript when bootstrap returns a partial event window", () => {
    const bootstrapEvents = [
      runtimeEvent("session-started", 10, { timestamp: "2026-07-01T10:00:00.000Z" }),
      runtimeEvent("turn-started", 11, { timestamp: "2026-07-01T10:00:01.000Z" }),
    ];
    const streamOnlyEvent = runtimeEvent("assistant-delta", undefined, {
      timestamp: "2026-07-01T10:00:01.000Z",
      name: "assistant.delta",
      output: "Hello",
    });
    const currentEvents = [
      runtimeEvent("older-stream-event", undefined, {
        timestamp: "2026-07-01T09:59:59.000Z",
      }),
      bootstrapEvents[1]!,
      streamOnlyEvent,
    ];

    expect(mergeBootstrapRuntimeEvents(bootstrapEvents, currentEvents)).toEqual([
      currentEvents[0],
      bootstrapEvents[0],
      bootstrapEvents[1],
      streamOnlyEvent,
    ]);
  });

  test("returns the newest available sequence from a sparse event list", () => {
    expect(latestRuntimeEventSequence([
      runtimeEvent("one", 10),
      runtimeEvent("stream-only"),
      runtimeEvent("two", 12),
      runtimeEvent("older", 11),
    ])).toBe(12);
  });

  test("keeps forward-fetched selected session events in the session page cache", () => {
    const selectedSessionId = "session_1";
    const otherSessionId = "session_2";
    const selectedBootstrapEvent = runtimeEvent("selected-bootstrap", 10, {
      sessionId: selectedSessionId,
      name: "workspace_action",
      action: "sandbox_preserve_source",
      status: "started",
    });
    const globalTailEvent = runtimeEvent("other-session-tail", 50, {
      sessionId: otherSessionId,
    });
    const forwardSelectedEvent = runtimeEvent("selected-apply-result", 20, {
      sessionId: selectedSessionId,
      name: "workspace_action_result",
      action: "sandbox_git_apply_patch_local",
      status: "completed",
      output: "Applied sandbox patch locally.",
    });

    const cache = mergeRuntimeEventsIntoSessionPageCache(
      {},
      selectedSessionId,
      [forwardSelectedEvent],
    );
    const refreshedRuntimeEvents = mergeBootstrapRuntimeEvents(
      [selectedBootstrapEvent, globalTailEvent],
      [selectedBootstrapEvent, globalTailEvent, forwardSelectedEvent],
    );
    const refreshedSelectedEvents = refreshedRuntimeEvents.filter(
      (event) => event.sessionId === selectedSessionId,
    );

    expect(refreshedSelectedEvents.map((event) => event.id)).toEqual([
      "selected-bootstrap",
      "selected-apply-result",
    ]);
    expect(mergeRuntimeEventLists(cache[selectedSessionId] ?? [], refreshedSelectedEvents).map((event) => event.id)).toEqual([
      "selected-bootstrap",
      "selected-apply-result",
    ]);
  });

  test("bounds the live projection while retaining the newest sequence window", () => {
    const events = Array.from(
      { length: MAX_LIVE_RUNTIME_EVENTS + 10 },
      (_, index) => runtimeEvent(`event-${index + 1}`, index + 1),
    );
    let merged: RuntimeEvent[] = [];
    for (let index = 0; index < events.length; index += 1_000) {
      merged = mergeLiveRuntimeEventLists(merged, events.slice(index, index + 1_000));
    }
    expect(merged).toHaveLength(MAX_LIVE_RUNTIME_EVENTS);
    expect(merged[0]?.sequence).toBe(11);
    expect(merged.at(-1)?.sequence).toBe(MAX_LIVE_RUNTIME_EVENTS + 10);
  });


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
