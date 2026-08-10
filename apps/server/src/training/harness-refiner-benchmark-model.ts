import { randomUUID } from "node:crypto";

import { DEFAULT_OPENPOND_CHAT_MODEL } from "@openpond/contracts";
import { DEFAULT_REFINER_MAX_OUTPUT_TOKENS } from "@openpond/harness";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

export function createHarnessRefinerBenchmarkModelStream(
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn,
) {
  return async function* ({
    messages,
    signal,
  }: {
    messages: Parameters<typeof streamOpenPondHostedChatTurn>[0]["messages"];
    signal: AbortSignal;
  }) {
    for await (const delta of streamOpenPondHostedChatTurn({
      model: DEFAULT_OPENPOND_CHAT_MODEL,
      messages,
      requestId: `harness-refiner-benchmark:${randomUUID()}`,
      reasoningEffort: "low",
      maxTokens: DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
      signal,
    })) {
      if (delta.type === "text_delta" && delta.text) {
        yield { text: delta.text };
      }
      if (delta.type === "usage") {
        yield { usage: delta.usage };
      }
    }
  };
}
