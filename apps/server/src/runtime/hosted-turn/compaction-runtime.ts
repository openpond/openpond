import type {
  ChatProvider,
  ModelUsageRecord,
  RuntimeEvent,
  Session,
  Turn,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import { buildChatMessagesForProvider } from "../../openpond/hosted-chat.js";
import {
  estimateHostedMessageTokens,
  trustedProviderContextLimit,
} from "../../openpond/context-usage.js";
import { resolveContextCompactionAdapter } from "../../openpond/context-adapter.js";
import {
  hostedAutoCompactionDecision,
  runHostedContextCompaction,
  type ContextCompactionStreamDelta,
  type HostedCompactionProvider,
  type HostedCompactionResult,
} from "../../openpond/context-compaction/index.js";
import { event } from "../../utils.js";
import { startProviderRequestUsageRecorder } from "../model-usage-recorder.js";
import type { TurnRunnerDependencies } from "../turns/ports.js";

type HostedMessages = ReturnType<typeof buildChatMessagesForProvider>;

export function createHostedCompactionRuntime(deps: {
  loadAppPreferences: NonNullable<TurnRunnerDependencies["loadAppPreferences"]>;
  appendRuntimeEvent: TurnRunnerDependencies["appendRuntimeEvent"];
  streamOpenPondHostedChatTurn?: typeof defaultStreamOpenPondHostedChatTurn;
  upsertModelUsageRecord(record: ModelUsageRecord): Promise<void>;
  throwIfInterrupted(signal: AbortSignal): void;
  interruptedError(): Error;
}) {
  const loadAppPreferences = deps.loadAppPreferences;
  const appendRuntimeEvent = deps.appendRuntimeEvent;
  const streamOpenPondHostedChatTurn =
    deps.streamOpenPondHostedChatTurn ?? defaultStreamOpenPondHostedChatTurn;
  const safeUpsertModelUsageRecord = deps.upsertModelUsageRecord;
  const throwIfInterrupted = deps.throwIfInterrupted;
  const interruptedError = deps.interruptedError;
  async function maybeAutoCompactHostedContext(params: {
    session: Session;
    turn: Turn;
    provider: HostedCompactionProvider;
    model: string;
    maxContextTokens?: number | null;
    priorEvents: RuntimeEvent[];
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
    streamCompactionChatTurn?: (input: {
      provider: ChatProvider;
      model: string;
      messages: HostedMessages;
      requestId: string;
      signal?: AbortSignal;
    }) => AsyncGenerator<ContextCompactionStreamDelta, void, unknown>;
  }): Promise<RuntimeEvent[]> {
    throwIfInterrupted(params.signal);
    const preferences = await loadAppPreferences();
    if (!preferences.contextCompaction.autoEnabled) return params.priorEvents;
    const adapter = resolveContextCompactionAdapter(params.provider);
    if (adapter.kind !== "app_summary") return params.priorEvents;
    const projectedMessages = buildChatMessagesForProvider(params.priorEvents, params.prompt, params.systemPrompt);
    const decision = hostedAutoCompactionDecision({
      provider: params.provider,
      model: params.model,
      messages: projectedMessages,
      maxContextTokens: params.maxContextTokens,
      triggerPercent: preferences.contextCompaction.triggerPercent,
    });
    if (!decision.shouldCompact || params.priorEvents.length === 0) return params.priorEvents;

    const startedEvent = event({
      sessionId: params.session.id,
      turnId: params.turn.id,
      name: "session.compaction.started",
      source: "server",
      appId: params.session.appId,
      status: "started",
      output: "Auto compacting conversation context",
      data: {
        version: 1,
        provider: params.provider,
        model: params.model,
        reason: "auto",
        projectedTokens: decision.projectedTokens,
        thresholdTokens: decision.thresholdTokens,
        usableContextTokens: decision.usableContextTokens,
        maxContextTokens: decision.maxContextTokens,
        tokenSource: decision.tokenSource,
      },
    });
    await appendRuntimeEvent(startedEvent);

    try {
      const result = await runRecordedHostedContextCompaction({
        session: params.session,
        turn: params.turn,
        events: params.priorEvents,
        provider: params.provider,
        model: params.model,
        maxContextTokens: params.maxContextTokens,
        signal: params.signal,
        streamCompactionChatTurn: params.streamCompactionChatTurn,
      });
      throwIfInterrupted(params.signal);
      const completedEvent = event({
        sessionId: params.session.id,
        turnId: params.turn.id,
        name: "session.compaction.completed",
        source: "server",
        appId: params.session.appId,
        status: "completed",
        output: "Auto compacted conversation context",
        data: {
          version: 1,
          provider: params.provider,
          model: result.model,
          reason: "auto",
          mode: "summary",
          summary: result.summary,
          compactedThroughEventId: result.compactedThroughEventId,
          compactedThroughTurnId: result.compactedThroughTurnId,
          preservedFromEventId: result.preservedFromEventId,
          preservedEventIds: result.preservedEventIds,
          preservedResourceRefs: result.preservedResourceRefs,
          sourceEventCount: result.sourceEventCount,
          preservedEventCount: result.preservedEventCount,
          fileLedger: result.fileLedger,
          inputTokensBefore: result.inputTokensBefore,
          inputTokensAfter: result.inputTokensAfter,
          maxContextTokens: result.maxContextTokens,
          tokenSource: result.tokenSource,
          metrics: result.metrics,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
        },
      });
      await appendRuntimeEvent(completedEvent);
      return [...params.priorEvents, startedEvent, completedEvent];
    } catch (error) {
      if (params.signal.aborted) throw interruptedError();
      const message = error instanceof Error ? error.message : String(error);
      const failedEvent = event({
        sessionId: params.session.id,
        turnId: params.turn.id,
        name: "session.compaction.failed",
        source: "server",
        appId: params.session.appId,
        status: "failed",
        output: "Auto context compaction failed",
        error: message,
        data: {
          version: 1,
          provider: params.provider,
          model: params.model,
          reason: "auto",
          error: message,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
          maxContextTokens: decision.maxContextTokens,
          tokenSource: decision.tokenSource,
        },
      });
      await appendRuntimeEvent(failedEvent);
      return [...params.priorEvents, startedEvent, failedEvent];
    }
  }

  async function throwIfAutoCompactionOffWouldExceedLimit(input: {
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    maxContextTokens?: number | null;
  }): Promise<void> {
    const preferences = await loadAppPreferences();
    if (preferences.contextCompaction.autoEnabled) return;
    const maxContextTokens =
      input.maxContextTokens ?? trustedProviderContextLimit({ provider: input.provider, model: input.model });
    if (!maxContextTokens) return;
    const projectedTokens = estimateHostedMessageTokens(input.messages);
    if (projectedTokens < maxContextTokens) return;
    throw new Error(
      [
        `This chat is at the context limit for ${input.provider}/${input.model}.`,
        "Start a new chat or turn auto compaction on to continue.",
      ].join(" "),
    );
  }

  async function runRecordedHostedContextCompaction(input: {
    session: Session;
    turn: Turn;
    events: RuntimeEvent[];
    provider: HostedCompactionProvider;
    model: string;
    maxContextTokens?: number | null;
    signal: AbortSignal;
    streamCompactionChatTurn?: (input: {
      provider: ChatProvider;
      model: string;
      messages: HostedMessages;
      requestId: string;
      signal?: AbortSignal;
    }) => AsyncGenerator<ContextCompactionStreamDelta, void, unknown>;
  }): Promise<HostedCompactionResult> {
    const usageState: {
      recorder: Awaited<ReturnType<typeof startProviderRequestUsageRecorder>> | null;
      finalized: boolean;
    } = { recorder: null, finalized: false };
    const requestId = `${input.turn.id}:context-compaction:0`;

    async function failUsageRecorder(error: unknown): Promise<void> {
      if (!usageState.recorder || usageState.finalized) return;
      usageState.finalized = true;
      await usageState.recorder.fail(
        error,
        input.signal.aborted || (error instanceof Error && error.name === "AbortError")
          ? "interrupted"
          : "failed",
      );
    }

    try {
      const streamCompactionChatTurn =
        input.streamCompactionChatTurn ??
        async function* (streamInput: {
          provider: ChatProvider;
          model: string;
          messages: HostedMessages;
          requestId: string;
          signal?: AbortSignal;
        }): AsyncGenerator<ContextCompactionStreamDelta, void, unknown> {
          if (streamInput.provider !== "openpond") {
            throw new Error(`Context compaction stream is not configured for ${streamInput.provider}.`);
          }
          for await (const delta of streamOpenPondHostedChatTurn({
            model: streamInput.model,
            messages: streamInput.messages,
            requestId: streamInput.requestId,
            signal: streamInput.signal,
          })) {
            if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
            if (delta.type === "reasoning_delta" && delta.text) yield { reasoningText: delta.text, raw: delta.raw };
            if (delta.type === "usage") yield { usage: delta.usage, raw: delta.raw };
          }
        };
      const result = await runHostedContextCompaction({
        session: input.session,
        events: input.events,
        provider: input.provider,
        model: input.model,
        maxContextTokens: input.maxContextTokens,
        signal: input.signal,
        streamCompactionChatTurn: async function* (streamInput) {
          usageState.recorder = await startProviderRequestUsageRecorder({
            session: input.session,
            turn: input.turn,
            provider: input.provider,
            model: streamInput.model ?? input.model,
            requestId,
            requestOrdinal: 0,
            requestKind: "context_compaction",
            upsert: safeUpsertModelUsageRecord,
          });
          try {
            for await (const delta of streamCompactionChatTurn(streamInput)) {
              if (delta.text) usageState.recorder.observeDelta({ text: delta.text });
              if (delta.reasoningText) usageState.recorder.observeDelta({ reasoningText: delta.reasoningText });
              if (delta.usage) usageState.recorder.observeDelta({ usage: delta.usage });
              yield delta;
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


  return {
    maybeAutoCompactHostedContext,
    throwIfAutoCompactionOffWouldExceedLimit,
  };
}
