import { expect, it } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { observeRemoteHistorySequence, remoteHistoryGeneration } from "./catalog.js";
import { projectRemoteEventChunks } from "./history.js";

// A provider's large snapshot must remain exact after bounded history paging,
// with replacement applied once and deterministic ordering across reconnects.
it("preserves large message snapshots through stable bounded fragments", () => {
  const text = "😀Quoted \\\" text\n".repeat(20_000);
  const event = { id: "event", name: "assistant.delta", turnId: "turn", output: text,
    data: { nativeMessageId: "message", nativeMessageSnapshot: true } } as RuntimeEvent;
  const chunks = [...projectRemoteEventChunks(event, 42)];
  expect(chunks.map(item => item.text).join("")).toBe(text);
  expect(chunks[0]?.textMode).toBe("replace");
  expect(chunks.slice(1).every(item => item.textMode === "append")).toBe(true);
  expect(chunks.every(item => item.sequence === 42 && item.messageId === "assistant:message" && Buffer.byteLength(JSON.stringify(item)) < 100_000)).toBe(true);
  expect(new Set(chunks.map(item => item.id)).size).toBe(chunks.length);
  expect([...projectRemoteEventChunks(event, 42, 16_000)]).toEqual(chunks.slice(2));
});

// A restored durable stream may reuse its old sequence numbers; acknowledgments
// from the prior incarnation must not silently skip its replacement history.
it("invalidates history generation on observed durable rollback", () => {
  const session = { id: "task", createdAt: "2026-10-08T00:00:00.000Z" } as Session;
  observeRemoteHistorySequence(500);
  const first = remoteHistoryGeneration(session);
  observeRemoteHistorySequence(501);
  expect(remoteHistoryGeneration(session)).toBe(first);
  expect(observeRemoteHistorySequence(200)).toBe(true);
  expect(remoteHistoryGeneration(session)).not.toBe(first);
});
