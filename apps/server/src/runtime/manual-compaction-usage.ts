import type { ChatProvider, RuntimeEvent, Session, ModelUsageRecord } from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStream } from "@openpond/runtime";
import { assertConfigRunCurrent, type EffectiveConfig } from "@openpond/persistence";
import { runHostedContextCompaction } from "../openpond/context-compaction/index.js";
import { startProviderRequestUsageRecorder } from "./model-usage-recorder.js";
import { streamOpenAiCompatibleChatCompletion } from "../openpond/openai-compatible-provider.js";
import { writeProviderChatGptSubscriptionCredential, type ProviderSecretStorePaths } from "../openpond/provider-secrets.js";
import { now } from "../utils.js";

type ByokInput = Parameters<typeof streamOpenAiCompatibleChatCompletion>[0];
export function createManualCompactionRecorder({ home, safeUpsertModelUsageRecord, streamOpenPondHostedChatTurn, localByokRuntimeState, providerSecretPaths }: {
  home: string;
  safeUpsertModelUsageRecord(record: ModelUsageRecord): Promise<void>;
  streamOpenPondHostedChatTurn: typeof defaultStream;
  localByokRuntimeState(): Promise<Pick<ByokInput, "settings" | "secrets">>;
  providerSecretPaths: ProviderSecretStorePaths;
}) {
  return async function runRecordedManualHostedContextCompaction(input: {
    session: Session;
    events: RuntimeEvent[];
    provider: ChatProvider;
    model: string | null;
    maxContextTokens?: number | null;
    route: "openpond_hosted" | "local_byok";
    requestId: string;
    configuration: EffectiveConfig;
  }) {
    const usageState: {
      recorder: Awaited<
        ReturnType<typeof startProviderRequestUsageRecorder>
      > | null;
      finalized: boolean;
    } = { recorder: null, finalized: false };

    async function failUsageRecorder(error: unknown): Promise<void> {
      if (!usageState.recorder || usageState.finalized) return;
      usageState.finalized = true;
      await usageState.recorder.fail(
        error,
        error instanceof Error && error.name === "AbortError"
          ? "interrupted"
          : "failed"
      );
    }

    try {
      const result = await runHostedContextCompaction({
        session: input.session,
        events: input.events,
        provider: input.provider,
        model: input.model,
        maxContextTokens: input.maxContextTokens,
        streamCompactionChatTurn: async function* (streamInput) {
          await assertConfigRunCurrent(home, input.configuration);
          usageState.recorder = await startProviderRequestUsageRecorder({
            session: input.session,
            turn: null,
            provider: input.provider,
            model: streamInput.model ?? input.model ?? "unknown",
            requestId: input.requestId,
            requestOrdinal: 0,
            requestKind: "context_compaction",
            upsert: safeUpsertModelUsageRecord,
          });
          try {
            if (input.route === "openpond_hosted") {
              for await (const delta of streamOpenPondHostedChatTurn({
                model: streamInput.model,
                messages: streamInput.messages,
                requestId: streamInput.requestId,
                signal: streamInput.signal,
              })) {
                if (delta.type === "text_delta" && delta.text)
                  usageState.recorder.observeDelta({ text: delta.text });
                if (delta.type === "reasoning_delta" && delta.text) {
                  usageState.recorder.observeDelta({
                    reasoningText: delta.text,
                  });
                }
                if (delta.type === "usage")
                  usageState.recorder.observeDelta({ usage: delta.usage });
                if (delta.type === "text_delta" && delta.text)
                  yield { text: delta.text, raw: delta.raw };
                if (delta.type === "reasoning_delta" && delta.text)
                  yield { reasoningText: delta.text, raw: delta.raw };
                if (delta.type === "usage")
                  yield { usage: delta.usage, raw: delta.raw };
              }
              return;
            }

            const state = await localByokRuntimeState();
            for await (const delta of streamOpenAiCompatibleChatCompletion({
              providerId: streamInput.provider,
              settings: state.settings,
              secrets: state.secrets,
              modelId: streamInput.model,
              messages: streamInput.messages,
              requestId: streamInput.requestId,
              promptCacheKey: input.session.id,
              signal: streamInput.signal,
              saveChatGptSubscriptionCredential: async (
                providerId,
                credential
              ) => {
                await writeProviderChatGptSubscriptionCredential({
                  paths: providerSecretPaths,
                  providerId,
                  credential,
                  expected: state.secrets.providers[providerId] ?? {},
                  timestamp: now(),
                });
              },
            })) {
              if (delta.type === "text_delta" && delta.text)
                usageState.recorder.observeDelta({ text: delta.text });
              if (delta.type === "reasoning_delta" && delta.text) {
                usageState.recorder.observeDelta({ reasoningText: delta.text });
              }
              if (delta.type === "usage")
                usageState.recorder.observeDelta({ usage: delta.usage });
              if (delta.type === "text_delta" && delta.text)
                yield { text: delta.text, raw: delta.raw };
              if (delta.type === "reasoning_delta" && delta.text)
                yield { reasoningText: delta.text, raw: delta.raw };
              if (delta.type === "usage")
                yield { usage: delta.usage, raw: delta.raw };
            }
          } catch (error) {
            await failUsageRecorder(error);
            throw error;
          }
        },
      });
      if (usageState.recorder && !usageState.finalized) {
        usageState.finalized = true;
        await usageState.recorder.complete();
      }
      return result;
    } catch (error) {
      await failUsageRecorder(error);
      throw error;
    }
  }

}
