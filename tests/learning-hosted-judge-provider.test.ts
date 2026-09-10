import { expect, it } from "vitest";
import type { HostedChatTurnInput } from "@openpond/runtime";
import { createLearningHostedJudgeProvider } from "../apps/server/src/training/learning-hosted-judge-provider.js";

// A fixture must not spend before its budget reservation, silently change a
// pinned model, or release money based on incomplete upstream usage.
it("prepares without inference and retains exact streaming identity and complete usage", async () => {
  const calls: HostedChatTurnInput[] = [];
  let partialUsage = false;
  let wrongModel = false;
  const provider = createLearningHostedJudgeProvider({
    catalog: async () => ({ error: null, models: [{ id: "judge", displayName: "Judge", ownedBy: "openpond", streaming: true,
      raw: { id: "judge", context_window: 8192, output_limit: 1024, metadata: { billing: { pricing: {
        version: "1", source: "test", effectiveAt: "2026-09-10", inputUsdPerMillionTokens: 2,
        cachedInputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 4,
      } } } } }] }),
    stream: async function* (input) {
      calls.push(input);
      const raw = { model: wrongModel ? "other" : "judge", id: "receipt-1" };
      yield { type: "text_delta", text: '{"score":1,"passed":true,"feedback":"Supported."}', raw };
      yield { type: "usage", usage: partialUsage ? { prompt_tokens: 100 } : { prompt_tokens: 100, completion_tokens: 20 }, raw };
      yield { type: "finish", finishReason: "stop", raw };
    },
  });
  const request = { providerId: "openpond", modelId: "judge", revision: null, temperature: 0.2, system: "Rubric", data: "Private evidence" };
  const prepared = await provider.prepare(request);
  expect(calls).toHaveLength(0);
  expect(prepared.maximumChargeUsd).toBeCloseTo(0.02048);
  expect(await prepared.dispatch()).toMatchObject({ modelId: "judge", modelRevision: null, responseId: "receipt-1", inputTokens: 100, outputTokens: 20, costUsd: 0.00028 });
  expect(calls[0]).toMatchObject({ model: "judge", temperature: 0.2, maxTokens: 1024, messages: [{ role: "system", content: "Rubric" }, { role: "user", content: "Private evidence" }] });
  partialUsage = true;
  expect(await prepared.dispatch()).toMatchObject({ outputTokens: null, costUsd: null });
  await expect(provider.prepare({ ...request, revision: "pinned" })).rejects.toThrow("cannot enforce a model revision");
  await expect(provider.prepare({ ...request, providerId: "openai" })).rejects.toThrow("not connected");
  wrongModel = true;
  // Preserve the actual identity; the bound runner rejects the grade while
  // retaining this response in its spend ledger.
  expect(await prepared.dispatch()).toMatchObject({ modelId: "other" });
  expect(calls).toHaveLength(3);
});
