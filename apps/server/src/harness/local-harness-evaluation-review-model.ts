import { DEFAULT_OPENPOND_CHAT_MODEL } from "@openpond/contracts";
import {
  DEFAULT_EVALUATION_REVIEW_MAX_OUTPUT_TOKENS,
  type HarnessEvaluationReviewModelStream,
} from "@openpond/harness";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

export function createLocalHarnessEvaluationReviewModelStream(
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn,
): HarnessEvaluationReviewModelStream {
  return async function* ({ messages, signal }) {
    for await (const delta of streamOpenPondHostedChatTurn({
      model: DEFAULT_OPENPOND_CHAT_MODEL,
      messages,
      requestId: `harness-continuous-review:${randomUUID()}`,
      reasoningEffort: "medium",
      maxTokens: DEFAULT_EVALUATION_REVIEW_MAX_OUTPUT_TOKENS,
      signal,
    })) {
      if (delta.type === "text_delta" && delta.text) {
        yield { text: delta.text };
      } else if (delta.type === "usage") {
        yield {
          usage: {
            promptTokens: delta.usage.prompt_tokens ?? 0,
            completionTokens: delta.usage.completion_tokens ?? 0,
            totalTokens: delta.usage.total_tokens ?? 0,
          },
        };
      }
    }
  };
}
import { randomUUID } from "node:crypto";
