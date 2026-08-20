import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import { IncrementalChatProjector } from "../apps/web/src/lib/incremental-chat-projector";

describe("IncrementalChatProjector", () => {
  test("matches full replay after every mixed-event batch", () => {
    const events = mixedEvents(18);
    const projector = new IncrementalChatProjector();

    for (let end = 1; end <= events.length; end += 3) {
      const prefix = events.slice(0, Math.min(events.length, end));
      expect(projector.project(prefix)).toEqual(buildChatMessages(prefix));
    }
    expect(projector.project(events)).toEqual(buildChatMessages(events));
  });

  test("matches full replay across seeded randomized batch boundaries", () => {
    const events = mixedEvents(36);
    for (let seed = 1; seed <= 20; seed += 1) {
      const projector = new IncrementalChatProjector();
      const random = seededRandom(seed);
      let end = 0;
      while (end < events.length) {
        end = Math.min(events.length, end + 1 + Math.floor(random() * 17));
        const prefix = events.slice(0, end);
        expect(projector.project(prefix)).toEqual(buildChatMessages(prefix));
      }
    }
  });

  test("preserves completed-turn message identity while a later turn streams", () => {
    const events = mixedEvents(2);
    const firstTurnEnd = events.findLastIndex((event) => event.turnId === "turn-0") + 1;
    const projector = new IncrementalChatProjector();
    const firstProjection = projector.project(events.slice(0, firstTurnEnd));
    const firstUser = firstProjection.find((message) => message.role === "user");

    const secondProjection = projector.project(events);

    expect(secondProjection.find((message) => message.id === firstUser?.id)).toBe(firstUser);
    expect(secondProjection).toEqual(buildChatMessages(events));
  });

  test("clones only the mutable assistant tail for appended deltas", () => {
    const initial = [
      event("start", "turn.started", "turn-0", { args: { prompt: "Hello" } }),
      event("delta-1", "assistant.delta", "turn-0", { output: "First" }),
    ];
    const projector = new IncrementalChatProjector();
    const first = projector.project(initial);
    const next = projector.project([
      ...initial,
      event("delta-2", "assistant.delta", "turn-0", { output: " second" }),
    ]);

    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1]?.content).toBe("First second");
  });

  test("keeps an assistant-only delta projection byte-equivalent to replay", () => {
    const initial = [
      event("start", "turn.started", "turn-0", { args: { prompt: "Hello" } }),
      event("delta-1", "assistant.delta", "turn-0", { output: "First" }),
    ];
    const projector = new IncrementalChatProjector();
    projector.project(initial);
    const events = [
      ...initial,
      event("delta-2", "assistant.delta", "turn-0", { output: " second" }),
    ];

    expect(JSON.stringify(projector.project(events))).toBe(
      JSON.stringify(buildChatMessages(events)),
    );
  });

  test("falls back to a full replay when history is prepended", () => {
    const projector = new IncrementalChatProjector();
    const later = mixedEvents(1);
    projector.project(later);
    const earlier = [
      event("earlier-start", "turn.started", "turn-earlier", { args: { prompt: "Earlier" } }),
      event("earlier-delta", "assistant.delta", "turn-earlier", { output: "Answer" }),
      event("earlier-complete", "turn.completed", "turn-earlier"),
      ...later,
    ];

    expect(projector.project(earlier)).toEqual(buildChatMessages(earlier));
  });
});

function mixedEvents(turnCount: number): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < turnCount; index += 1) {
    const turnId = `turn-${index}`;
    events.push(
      event(`${turnId}-start`, "turn.started", turnId, {
        args: { prompt: `Prompt ${index}` },
      }),
      event(`${turnId}-reasoning`, "assistant.reasoning.delta", turnId, {
        output: `Reasoning ${index}. `,
      }),
      event(`${turnId}-tool-start`, "tool.started", turnId, {
        action: "exec_command",
        data: { tool: "exec_command", command: "pnpm test" },
      }),
      event(`${turnId}-tool-output`, "command.output", turnId, {
        output: "tests passed\n",
      }),
      event(`${turnId}-tool-complete`, "tool.completed", turnId, {
        action: "exec_command",
        output: "tests passed",
      }),
      event(`${turnId}-delta-1`, "assistant.delta", turnId, {
        output: `Answer ${index}`,
      }),
      event(`${turnId}-delta-2`, "assistant.delta", turnId, {
        output: " complete.",
      }),
      event(`${turnId}-complete`, "turn.completed", turnId),
    );
  }
  return events;
}

function event(
  id: string,
  name: string,
  turnId: string,
  extra: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    id,
    name,
    turnId,
    sessionId: "session-1",
    timestamp: new Date(1_750_000_000_000 + id.length).toISOString(),
    source: "provider",
    ...extra,
  } as RuntimeEvent;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
