import type {
  ChatProvider,
  ModelUsageRecord,
  RuntimeEvent,
  Session,
  Turn,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { HostedChatTool } from "@openpond/cloud";
import { buildChatMessagesForProvider } from "../../openpond/hosted-chat.js";
import {
  estimateHostedRequestBudget,
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
  runtimeEventsForSession: TurnRunnerDependencies["store"]["runtimeEventsForSession"];
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
    messagesOverride?: HostedMessages;
    tools?: readonly HostedChatTool[];
    maxOutputTokens?: number;
    force?: boolean;
    failClosed?: boolean;
    reason?: "auto" | "overflow_recovery";
    roundIndex?: number;
  }): Promise<RuntimeEvent[]> {
    throwIfInterrupted(params.signal);
    const preferences = await loadAppPreferences();
    if (!preferences.contextCompaction.autoEnabled) return params.priorEvents;
    const adapter = resolveContextCompactionAdapter(params.provider);
    if (adapter.kind !== "app_summary") return params.priorEvents;
    const projectedMessages = params.messagesOverride
      ?? buildChatMessagesForProvider(params.priorEvents, params.prompt, params.systemPrompt);
    const decision = hostedAutoCompactionDecision({
      provider: params.provider,
      model: params.model,
      messages: projectedMessages,
      tools: params.tools,
      maxOutputTokens: params.maxOutputTokens,
      maxContextTokens: params.maxContextTokens,
      triggerPercent: preferences.contextCompaction.triggerPercent,
    });
    if ((!decision.shouldCompact && !params.force) || params.priorEvents.length === 0) return params.priorEvents;
    const reason = params.reason ?? "auto";
    const compactionOrdinal = params.priorEvents.filter(
      (item) => item.name === "session.compaction.started" && item.turnId === params.turn.id,
    ).length;

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
        reason,
        roundIndex: params.roundIndex ?? null,
        requestBudget: decision.requestBudget,
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
        compactionOrdinal,
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
          reason,
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
          continuationCapsule: result.continuationCapsule,
          inputTokensBefore: result.inputTokensBefore,
          inputTokensAfter: result.inputTokensAfter,
          maxContextTokens: result.maxContextTokens,
          tokenSource: result.tokenSource,
          metrics: result.metrics,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
          roundIndex: params.roundIndex ?? null,
          requestBudget: decision.requestBudget,
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
          reason,
          error: message,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
          maxContextTokens: decision.maxContextTokens,
          tokenSource: decision.tokenSource,
          roundIndex: params.roundIndex ?? null,
          requestBudget: decision.requestBudget,
        },
      });
      await appendRuntimeEvent(failedEvent);
      if (params.failClosed) throw error;
      return [...params.priorEvents, startedEvent, failedEvent];
    }
  }

  async function prepareHostedProviderRequest(params: {
    session: Session;
    turn: Turn;
    provider: HostedCompactionProvider;
    model: string;
    maxContextTokens?: number | null;
    messages: HostedMessages;
    tools?: readonly HostedChatTool[];
    maxOutputTokens: number;
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
    roundIndex: number;
    force?: boolean;
    streamCompactionChatTurn?: (input: {
      provider: ChatProvider;
      model: string;
      messages: HostedMessages;
      requestId: string;
      signal?: AbortSignal;
    }) => AsyncGenerator<ContextCompactionStreamDelta, void, unknown>;
  }): Promise<{
    messages: HostedMessages;
    compacted: boolean;
    requestBudget: ReturnType<typeof estimateHostedRequestBudget>;
  }> {
    const maxContextTokens =
      params.maxContextTokens
      ?? trustedProviderContextLimit({ provider: params.provider, model: params.model });
    const beforeBudget = estimateHostedRequestBudget({
      provider: params.provider,
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      maxOutputTokens: params.maxOutputTokens,
      maxContextTokens,
    });
    if (!maxContextTokens && !params.force) {
      return {
        messages: params.messages,
        compacted: false,
        requestBudget: beforeBudget,
      };
    }
    const priorEvents = await deps.runtimeEventsForSession(params.session.id);
    const preparedEvents = await maybeAutoCompactHostedContext({
      ...params,
      maxContextTokens,
      priorEvents,
      messagesOverride: params.messages,
      failClosed: Boolean(params.force),
      reason: params.force ? "overflow_recovery" : "auto",
    });
    const compacted = preparedEvents.some(
      (item, index) => index >= priorEvents.length && item.name === "session.compaction.completed",
    );
    const messages = compacted
      ? buildChatMessagesForProvider(preparedEvents, "", params.systemPrompt)
      : params.messages;
    const requestBudget = estimateHostedRequestBudget({
      provider: params.provider,
      model: params.model,
      messages,
      tools: params.tools,
      maxOutputTokens: params.maxOutputTokens,
      maxContextTokens,
    });
    if (maxContextTokens && requestBudget.projectedTokens >= maxContextTokens) {
      throw new Error([
        `The physical provider request for ${params.provider}/${params.model} exceeds its context window`,
        `(${requestBudget.projectedTokens}/${maxContextTokens} projected tokens).`,
        compacted
          ? "Compaction completed, but tool schemas, output allowance, and retained context still do not fit."
          : "Turn auto compaction on, reduce the active tool/profile surface, or start a new task.",
      ].join(" "));
    }
    return {
      messages,
      compacted,
      requestBudget: compacted ? requestBudget : beforeBudget,
    };
  }

  async function runRecordedHostedContextCompaction(input: {
    session: Session;
    turn: Turn;
    events: RuntimeEvent[];
    provider: HostedCompactionProvider;
    model: string;
    maxContextTokens?: number | null;
    signal: AbortSignal;
    compactionOrdinal?: number;
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
    const requestOrdinal = input.compactionOrdinal ?? 0;
    const requestId = `${input.turn.id}:context-compaction:${requestOrdinal}`;

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
            requestOrdinal,
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
    prepareHostedProviderRequest,
  };
}
