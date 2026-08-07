export type ProviderRoundContext = {
  index: number;
  requestId: string;
  signal: AbortSignal;
};

export type ProviderRoundDecision<TResult> =
  | { type: "continue" }
  | { type: "complete"; result: TResult };

export type ProviderStreamDelta<TToolCall = unknown, TContinuation = unknown> = {
  text?: string;
  reasoningText?: string;
  usage?: unknown;
  continuation?: TContinuation;
  toolCalls?: readonly TToolCall[];
  finishReason?: string | null;
};

export type ProviderRoundResult<TToolCall = unknown, TContinuation = unknown> = {
  text: string;
  reasoningText: string;
  usage: unknown;
  continuation: TContinuation | null;
  toolCallBatches: TToolCall[][];
  finishReason: string | null | undefined;
};

export async function* providerRoundSequence(input: {
  turnId: string;
  maxRounds: number;
  signal: AbortSignal;
}): AsyncGenerator<ProviderRoundContext, void, unknown> {
  if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1) {
    throw new Error("Provider maxRounds must be a positive integer.");
  }
  for (let index = 0; index < input.maxRounds; index += 1) {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Provider loop interrupted.");
    yield {
      index,
      requestId: `${input.turnId}:model:${index}`,
      signal: input.signal
    };
  }
}

/** Owns provider/tool round sequencing, completion, exhaustion, and aborts. */
export async function runProviderRoundLoop<TResult>(input: {
  turnId: string;
  maxRounds: number;
  signal: AbortSignal;
  runRound(round: ProviderRoundContext): Promise<ProviderRoundDecision<TResult>>;
  onExhausted(): Promise<TResult>;
}): Promise<TResult> {
  for await (const round of providerRoundSequence(input)) {
    const decision = await input.runRound(round);
    if (decision.type === "complete") return decision.result;
  }
  return input.onExhausted();
}

/**
 * Owns provider stream consumption and the normalized round result. The host
 * supplies the provider request, usage recorder, and provider-specific delta
 * shapes without duplicating the stream lifecycle.
 */
export async function runProviderRound<
  TToolCall = unknown,
  TContinuation = unknown,
>(input: {
  stream: AsyncIterable<ProviderStreamDelta<TToolCall, TContinuation>>;
  signal: AbortSignal;
  onDelta?(delta: ProviderStreamDelta<TToolCall, TContinuation>): void;
  onCompleted?(result: ProviderRoundResult<TToolCall, TContinuation>): Promise<void>;
  onFailed?(error: unknown): Promise<void>;
}): Promise<ProviderRoundResult<TToolCall, TContinuation>> {
  let text = "";
  let reasoningText = "";
  let usage: unknown;
  let continuation: TContinuation | null = null;
  let finishReason: string | null | undefined;
  const toolCallBatches: TToolCall[][] = [];

  try {
    for await (const delta of input.stream) {
      input.onDelta?.(delta);
      if (input.signal.aborted) {
        throw input.signal.reason ?? new Error("Provider round interrupted.");
      }
      if (delta.text) text += delta.text;
      if (delta.reasoningText) reasoningText += delta.reasoningText;
      if (delta.usage !== undefined) usage = delta.usage;
      if (delta.continuation !== undefined) continuation = delta.continuation;
      if (delta.toolCalls) toolCallBatches.push([...delta.toolCalls]);
      if (delta.finishReason !== undefined) finishReason = delta.finishReason;
    }
    const result = {
      text,
      reasoningText,
      usage,
      continuation,
      toolCallBatches,
      finishReason,
    } satisfies ProviderRoundResult<TToolCall, TContinuation>;
    await input.onCompleted?.(result);
    return result;
  } catch (error) {
    await input.onFailed?.(error);
    throw error;
  }
}
