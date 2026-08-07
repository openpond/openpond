export type ProviderRoundContext = {
  index: number;
  requestId: string;
  signal: AbortSignal;
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
