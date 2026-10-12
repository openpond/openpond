import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { MessageRow } from "../apps/web/src/components/chat/Messages";
import type { ChatMessage } from "../apps/web/src/lib/app-models";
import type { UsageTurnCacheSummary } from "@openpond/contracts";

const reveal = vi.hoisted(() => ({ content: "", reasoning: "" }));
vi.mock("../apps/web/src/hooks/useSmoothStreamingText", () => ({
  useSmoothStreamingText: (content: string) => !content ? "" : content.startsWith("Reasoning") ? reveal.reasoning : reveal.content,
}));

describe("assistant completion footer", () => {
  // Failure story: provider completion can arrive before the animated text catches
  // up, exposing timestamps/cache stats (and copy) beneath an unfinished response.
  test("waits for provider completion and all visible text, including resumed deltas", () => {
    const message: ChatMessage = { id: "answer", role: "assistant", content: "Final answer",
      timestamp: "2026-10-12T14:00:00.000Z", turnId: "turn" };
    const cache = { cacheHitRate: 0.8 } as UsageTurnCacheSummary;
    const render = () => renderToStaticMarkup(createElement(MessageRow, { message, kvCacheSummary: cache }));
    const expectFooter = (visible: boolean) => {
      const html = render();
      for (const marker of ['<time ', 'aria-label="KV cache reuse', 'aria-label="Copy assistant message"']) {
        expect(html.includes(marker)).toBe(visible);
      }
    };

    reveal.content = message.content!;
    expectFooter(false); // Visible text alone is not provider completion.
    message.finalAnswer = true;
    reveal.content = "Final";
    expectFooter(false); // Provider is done, but the reveal is still running.
    reveal.content = message.content!;
    expectFooter(true);
    message.content += " with more detail";
    expectFooter(false); // A new target must hide stale completion metadata immediately.
    reveal.content = message.content;
    message.reasoningContent = "Reasoning complete";
    reveal.reasoning = "Reasoning";
    expectFooter(false);
    reveal.reasoning = message.reasoningContent;
    expectFooter(true);
  });
});
