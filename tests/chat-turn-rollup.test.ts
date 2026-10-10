import { expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import type { HtmlVisualReference } from "@openpond/contracts/html-visuals";
import type { ChatMessage } from "../apps/web/src/lib/app-models";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import { buildChatTimelineRows, chatTimelineMessages } from "../apps/web/src/lib/chat-timeline-rows";

function event(id: string, name: string, seconds: number, fields: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return { id, name, sessionId: "chat", turnId: "turn", timestamp: new Date(Date.UTC(2026, 9, 9, 12, 0, seconds)).toISOString(), ...fields };
}

// One event-to-timeline boundary protects all providers from hidden live work,
// duplicate final answers, lost reasoning/tool details, and inaccurate duration.
test("completed hosted and native turns roll up losslessly while live turns remain visible", () => {
  for (const provider of ["openpond", "codex", "claude-code"]) {
    const data = (id: string, phase: string) => provider === "openpond" ? undefined
      : { nativeMessageId: id, phase, ...(phase === "final_answer" ? { nativeMessageSnapshot: true } : {}) };
    const events = [
      event("start", "turn.started", 0, { args: { prompt: "Inspect the app", provider } }),
      event("progress", "assistant.delta", 10, { output: "Checking the files", data: data("progress", "commentary") }),
      event("tool", "tool.started", 20, { action: "exec_command", data: { callId: "tool", command: "ls" } }),
      event("tool-end", "tool.completed", 30, { action: "exec_command", output: "file.txt", data: { callId: "tool", command: "ls" } }),
      event("reason", "assistant.reasoning.delta", 40, { output: "The checks passed", data: data("reason", "reasoning") }),
      event("answer", "assistant.delta", 60, { output: "All done", data: data("answer", "final_answer") }),
    ];
    const live = buildChatMessages(events);
    expect(buildChatTimelineRows(live).every(row => row.type === "message")).toBe(true);
    const completed = buildChatMessages([...events, event("complete", "turn.completed", 149)]);
    const rows = buildChatTimelineRows(completed);
    expect(rows.map(row => row.type)).toEqual(["message", "work", "message"]);
    const work = rows[1]!;
    expect(work.type).toBe("work");
    if (work.type !== "work") throw new Error("Expected completed history");
    expect(work.label).toBe("Worked for 2m 29s");
    expect(work.messages.some(row => row.message.activities?.some(activity => activity.callId === "tool"))).toBe(true);
    const flattened = chatTimelineMessages(rows);
    expect(flattened.flatMap(message => message.content ? [message.content] : [])).toEqual(completed.flatMap(message => message.content ? [message.content] : []));
    expect(flattened.flatMap(message => message.reasoningContent ? [message.reasoningContent] : [])).toEqual(completed.flatMap(message => message.reasoningContent ? [message.reasoningContent] : []));
    const final = rows[2]!;
    expect(final.type === "message" && final.showFooter).toBe(true);
    expect(final.type === "message" && final.message.content).toBe("All done");
    expect(final.type === "message" && final.message.reasoningContent).toBeUndefined();
    expect(work.messages.every(row => !row.showFooter)).toBe(true);
  }
});

test("steer rolls up only previous work, keeping both user messages and new work visible", () => {
  const projected = buildChatMessages([
    event("start", "turn.started", 0, { args: { prompt: "Initial request" } }),
    event("progress", "assistant.delta", 10, { output: "Initial progress" }),
    event("steer", "turn.started", 20, { turnId: "steered", args: { prompt: "Focus here", interactionKind: "steer" } }),
    event("new-progress", "assistant.delta", 30, { turnId: "steered", output: "New progress" }),
  ]);
  const rows = buildChatTimelineRows(projected);
  expect(rows.map(row => row.type)).toEqual(["message", "work", "message", "message"]);
  expect(chatTimelineMessages(rows)).toEqual(projected);
  expect(rows[1]?.type === "work" && rows[1].messages.map(row => row.message.content)).toEqual(["Initial progress"]);
  expect(rows[2]?.type === "message" && rows[2].message.content).toBe("Focus here");
});

test("failed work and unanswered questions never get hidden by a turn rollup", () => {
  const projected = buildChatMessages([
    event("start", "turn.started", 0, { args: { prompt: "Request" } }),
    event("progress", "assistant.delta", 10, { output: "Progress" }),
    event("fail", "turn.failed", 20, { error: "Could not complete" }),
  ]);
  expect(buildChatTimelineRows(projected).every(row => row.type === "message")).toBe(true);
  const question = { id: "question", role: "assistant", timestamp: projected[0]!.timestamp,
    userQuestion: { status: "pending" } } as ChatMessage;
  expect(buildChatTimelineRows([...projected, question]).at(-1)).toMatchObject({ type: "message", message: question });
});

// Completing or steering a turn used to move the iframe into a disclosure,
// hiding the published output and destroying the user's interactive state.
test("published visuals retain top-level identity at the response bottom across streaming, completion and steering", () => {
  const visual: HtmlVisualReference = {
    visualId: `visual_${"a".repeat(32)}`, publicationId: `visual_pub_${"b".repeat(32)}`,
    sessionId: "chat", turnId: "turn", heights: [{ width: 680, height: 320 }],
    output: { id: "output", title: "Interactive project map", sourceTaskId: "chat", sourceTurnId: "turn",
      revision: 1, createdAt: event("date", "date", 0).timestamp, kind: "file", contentType: "text/html",
      sizeBytes: 100, sha256: "c".repeat(64), validation: [],
      location: { kind: "managed", fileId: "file", downloadPath: "/visual.html" } },
  };
  for (const provider of ["openpond", "codex", "claude-code"]) {
    const native = (id: string, phase: string) => provider === "openpond" ? undefined
      : { nativeMessageId: id, phase, ...(phase === "final_answer" ? { nativeMessageSnapshot: true } : {}) };
    const events = [
      event("start", "turn.started", 0, { args: { prompt: "Visualize this project", provider } }),
      event("before", "assistant.delta", 10, { output: "Preparing the visual", data: native("before", "commentary") }),
      event("visual", "visual.published", 20, { data: { visual } }),
      event("after", "assistant.delta", 30, { output: "Checking the published output", data: native("after", "commentary") }),
    ];
    const live = buildChatTimelineRows(buildChatMessages(events));
    const original = live.find(row => row.type === "message" && row.message.visual);
    expect(original).toMatchObject({ id: `message:${visual.publicationId}`, type: "message" });
    expect(live.at(-1)).toEqual(original);
    for (const ending of [
      [event("answer", "assistant.delta", 40, { output: "Done", data: native("answer", "final_answer") }),
        event("complete", "turn.completed", 50)],
      [event("steer", "turn.started", 40, { turnId: "next", args: { prompt: "Focus on runtime", interactionKind: "steer" } })],
    ]) {
      const messages = buildChatMessages([...events, ...ending]);
      const rows = buildChatTimelineRows(messages);
      expect(rows.find(row => row.id === original!.id)).toEqual(original);
      expect(rows.filter(row => row.type === "work").length).toBeGreaterThan(0);
      expect(rows.filter(row => row.type === "work").flatMap(row => row.messages).some(row => row.message.visual)).toBe(false);
      // Presentation reorders the output, but loses neither messages nor identity.
      expect(chatTimelineMessages(rows).map(message => message.id).sort()).toEqual(messages.map(message => message.id).sort());
      const visualIndex = rows.findIndex(row => row.id === original!.id);
      expect(chatTimelineMessages(rows.slice(0, visualIndex)).some(message => message.content?.includes("Checking the published output"))).toBe(true);
      const nextUser = rows.findIndex(row => row.type === "message" && row.message.turnId === "next");
      expect(visualIndex).toBe(nextUser < 0 ? rows.length - 1 : nextUser - 1);
      expect(buildChatTimelineRows(buildChatMessages([...events, ...ending]))).toEqual(rows);
      const resource: ChatMessage = { id: "chat-resources:turn", role: "resources", turnId: "turn", timestamp: visual.output.createdAt, resources: [] };
      const withResource = [...messages];
      const lastTurnIndex = withResource.findLastIndex(message => message.turnId === "turn");
      withResource.splice(lastTurnIndex + 1, 0, resource);
      const resourceRows = buildChatTimelineRows(withResource);
      const resourceIndex = resourceRows.findIndex(row => row.type === "message" && row.message.id === resource.id);
      expect(resourceIndex).toBeGreaterThanOrEqual(0);
      expect(resourceRows.findIndex(row => row.id === original!.id)).toBe(resourceIndex + 1);
    }
  }
});
