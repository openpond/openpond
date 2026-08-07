export type ProviderRoundContext = {
  index: number;
  requestId: string;
  signal: AbortSignal;
};

export type ProviderRoundDecision<TResult> =
  | { type: "continue" }
  | { type: "complete"; result: TResult };

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
