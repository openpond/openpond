import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import { buildChatTimelineRows } from "../apps/web/src/lib/chat-timeline-rows";
import { startedAgentNames } from "../apps/web/src/lib/chat-activity-summary";
import { IncrementalChatProjector } from "../apps/web/src/lib/incremental-chat-projector";

describe("IncrementalChatProjector", () => {
  // Completion events omit launch arguments. Keep the original worker title
  // through streaming/replay, without claiming failed attempts were created.
  test("retains confirmed agent launch names through tool completion and later commands", () => {
    const events = [
      event("turn", "turn.started", "turn-1", {args:{prompt:"Delegate"}}),
      event("launch", "tool.started", "turn-1", {action:"openpond_start_agent",args:{title:"Desktop review"},data:{callId:"launch"}}),
      event("launched", "tool.completed", "turn-1", {action:"openpond_start_agent",status:"completed",data:{callId:"launch",result:{sessionId:"created-worker"}}}),
      event("failed-launch", "tool.started", "turn-1", {action:"openpond_start_agent",args:{title:"Unavailable worker"},data:{callId:"failed-launch"}}),
      event("failed", "tool.completed", "turn-1", {action:"openpond_start_agent",status:"failed",data:{callId:"failed-launch"}}),
      event("native", "subagent.started", "turn-1", {data:{childSessionId:"child",run:{title:"Native review",roleId:"reviewer"}}}),
      event("inspect", "tool.completed", "turn-1", {action:"openpond_inspect_agent",status:"completed"}),
    ];
    const projector = new IncrementalChatProjector();
    for (let end=1;end<=events.length;end++) {
      const prefix=events.slice(0,end);
      const messages=projector.project(prefix);
      expect(messages).toEqual(buildChatMessages(prefix));
      const names=startedAgentNames(messages.flatMap(message=>message.activities??[]));
      expect(names).toEqual(end<3?[]:end<6?["Desktop review"]:["Desktop review","Native review"]);
      if(end>=3)expect(messages.flatMap(message=>message.activities??[]).find(activity=>activity.startedAgent==="Desktop review")?.openSession?.sessionId).toBe("created-worker");
    }
  });
  // A single durable assignment emits pending/included/resolved receipts across
  // turns. Streaming must not display multiple sends or move its original row.
  test("retains one peer receipt across streamed delivery updates and later turns", () => {
    const receipt = (state: "pending" | "included" | "resolved", turnId: string): RuntimeEvent => event(`receipt-${state}`, "task.input", turnId, {
      data: { input: { id: "assignment", sequence: 1, sessionId: "worker", senderSessionId: "session-1", senderKind: "task", kind: "followup", body: "Bounded assignment", payload: {}, idempotencyKey: "assignment", replyTo: null, expectedTurnId: null, turnId: state === "pending" ? null : "worker-turn", requestIds: [], state, revision: 1, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: state === "pending" ? "2026-10-15T00:00:00.000Z" : "2026-10-15T00:00:01.000Z", error: null }, delivery: { direction: "sent", peer: { sessionId: "worker", title: "Worker", provider: "codex" } } },
    });
    const events = [event("start", "turn.started", "turn-1", { args: { prompt: "Delegate" } }), receipt("pending", "turn-1"), receipt("included", "turn-1"), event("answer", "assistant.delta", "turn-1", { output: "Started" }), event("complete", "turn.completed", "turn-1"), event("next", "turn.started", "turn-2", { args: { prompt: "Inspect" } }), receipt("resolved", "turn-2")];
    const projector = new IncrementalChatProjector();
    for (let end = 1; end <= events.length; end++) {
      const prefix = events.slice(0, end);
      const messages = projector.project(prefix);
      expect(messages).toEqual(buildChatMessages(prefix));
      expect(messages.filter(message => message.role === "task_message")).toHaveLength(end > 1 ? 1 : 0);
    }
  });
  // An agent receipt between tool start/end used to strand a shimmering start
  // alongside a duplicate completed tool, including after history replay.
  test("settles the original tool across an intervening peer receipt", () => {
    const events = [
      event("start", "turn.started", "turn-1", {args: {prompt: "Ask a worker"}}),
      event("call", "tool.started", "turn-1", {action: "openpond_followup_task", data: {callId: "call-1"}}),
      event("receipt", "task.input", "turn-1", {data: {input: {
        id: "assignment", sequence: 1, sessionId: "worker", senderSessionId: "session-1", senderKind: "task", kind: "followup",
        body: "Do the work", payload: {}, idempotencyKey: "assignment", replyTo: null, expectedTurnId: null, turnId: null,
        requestIds: [], state: "pending", revision: 1, createdAt: "2026-07-01T10:00:00Z", updatedAt: "2026-07-01T10:00:00Z", error: null,
      }, delivery: {direction: "sent", peer: {sessionId: "worker", title: "Worker", provider: "codex"}}}}),
      event("done", "tool.completed", "turn-1", {action: "openpond_followup_task", status: "completed", data: {callId: "call-1"}}),
      event("answer", "assistant.delta", "turn-1", {output: "Done"}),
      event("complete", "turn.completed", "turn-1"),
    ];
    const projector = new IncrementalChatProjector();
    for (let end = 1; end <= events.length; end++) {
      const prefix = events.slice(0, end);
      const messages = projector.project(prefix);
      expect(messages).toEqual(buildChatMessages(prefix));
      const calls = messages.flatMap(message => message.activities ?? []).filter(activity => activity.callId === "call-1");
      expect(calls).toHaveLength(end >= 2 ? 1 : 0);
      if (end >= 4) expect(calls[0]?.state).toBe("completed");
    }
    expect(projector.project(events).filter(message => message.role === "task_message")).toHaveLength(1);
  });

  // Progress must never acquire the wrap-up controls during streaming or
  // after reload; completed turns retain their footer as the next turn starts.
  test.each(["openpond", "codex", "claude-code"])("exposes only completed wrap-up footers for %s", (provider) => {
    const native = provider === "claude-code";
    const codex = provider === "codex";
    const events = [
      event("start", "turn.started", "turn-1", { args: { prompt: "Work" } }),
      event("progress", codex ? "assistant.reasoning.delta" : "assistant.delta", "turn-1", {
        output: "Working",
        data: { phase: "commentary", ...(native ? { nativeMessageId: "native-progress" } : {}) },
      }),
      event("tool", "tool.started", "turn-1", { action: "read", data: { callId: "read" } }),
      event("tool-done", "tool.completed", "turn-1", { action: "read", data: { callId: "read" } }),
      event("answer", "assistant.delta", "turn-1", {
        output: "Done",
        data: native ? { nativeMessageId: "native-final", phase: "final_answer", nativeMessageSnapshot: true }
          : codex ? { phase: "final_answer" } : {},
      }),
    ];
    const projector = new IncrementalChatProjector();
    const footerContents = (messages: ReturnType<typeof buildChatMessages>) => buildChatTimelineRows(messages)
      .flatMap(row => row.type === "message" && row.showFooter ? [row.message.content] : []);
    for (let end = 1; end <= events.length; end++) {
      expect(footerContents(projector.project(events.slice(0, end)))).toEqual([]);
    }
    events.push(event("complete", "turn.completed", "turn-1"));
    expect(footerContents(projector.project([...events]))).toEqual(["Done"]);
    events.push(
      event("next", "turn.started", "turn-2", { args: { prompt: "Next" } }),
      event("next-progress", "assistant.delta", "turn-2", { output: "Still working" }),
      event("stop", "turn.interrupted", "turn-2"),
      event("third", "turn.started", "turn-3", { args: { prompt: "Try again" } }),
      event("third-progress", "assistant.delta", "turn-3", { output: "Trying" }),
      event("failed", "turn.failed", "turn-3", { error: "Provider failed" }),
    );
    const streamed = projector.project([...events]);
    expect(streamed).toEqual(buildChatMessages(JSON.parse(JSON.stringify(events))));
    expect(footerContents(streamed)).toEqual(["Done"]);
  });

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
