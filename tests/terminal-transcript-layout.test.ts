import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { buildFrame } from "../apps/terminal/src/ui/layout";
import { TranscriptLayoutCache } from "../apps/terminal/src/ui/transcript-layout-cache";
import {
  appendRuntimeEvent,
  MAX_ACTIVE_STREAMING_TEXT_BYTES,
  type TranscriptItem,
} from "../apps/terminal/src/ui/transcript";

const status = {
  provider: "OpenPond",
  model: "test",
  cwd: "/tmp/openpond",
  profile: "local",
  agent: null,
  running: true,
  sessionId: "session-a",
  notice: null,
};

function frame(transcript: TranscriptItem[], cache?: TranscriptLayoutCache) {
  return buildFrame({
    cols: 80,
    rows: 10,
    transcript,
    composer: { text: "", cursor: 0, history: [], historyIndex: null },
    slashMenu: null,
    status,
    scrollOffset: 0,
    transcriptLayoutCache: cache,
  });
}

describe("terminal transcript layout cache", () => {
  test("matches uncached wrapping while reusing append-only assistant prefixes", () => {
    const cache = new TranscriptLayoutCache();
    const assistant = (text: string): TranscriptItem => ({
      id: "assistant-a",
      kind: "assistant",
      text,
      streaming: true,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    let text = "";
    for (const delta of ["hello ", "world ".repeat(30), "\ncode ".repeat(20), "finished"]) {
      text += delta;
      expect(frame([assistant(text)], cache).lines).toEqual(frame([assistant(text)]).lines);
    }
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().processedCharacters).toBeLessThan(text.length * 2);
  });

  test("keeps 50 MiB of incoming deltas within the live byte and incremental-wrap budgets", () => {
    const cache = new TranscriptLayoutCache();
    let transcript: TranscriptItem[] = [];
    const chunk = "streaming output ".repeat(4096);
    const iterations = Math.ceil((50 * 1024 * 1024) / new TextEncoder().encode(chunk).byteLength);
    for (let index = 0; index < iterations; index += 1) {
      const event: RuntimeEvent = {
        id: `event-${index}`,
        sessionId: "session-a",
        turnId: "turn-a",
        name: "assistant.delta",
        source: "provider",
        timestamp: "2026-07-10T00:00:00.000Z",
        output: chunk,
      };
      transcript = appendRuntimeEvent(transcript, event);
      frame(transcript, cache);
    }
    const assistant = transcript[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant transcript");
    expect(new TextEncoder().encode(assistant.text).byteLength).toBeLessThanOrEqual(MAX_ACTIVE_STREAMING_TEXT_BYTES);
    expect(assistant.truncated).toBe(true);
    expect(cache.stats().processedCharacters).toBeLessThan(MAX_ACTIVE_STREAMING_TEXT_BYTES * 2);
  });
});
