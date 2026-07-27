export type PrimeComputeQuoteCandidate = {
  device: { id: string; name: string };
  hourlyCostUsd: number;
  estimatedCostUsd: number;
  quoteId: string;
  deadline: string;
  durationMs: number;
};

export function choosePrimeComputeQuote(input: {
  devices: Array<{ id: string; name: string }>;
  hourlyQuotes: Map<
    string,
    {
      quoteId: string;
      hourlyCostUsd: number;
    }
  >;
  walletBalanceUsd: number;
  now: Date;
  minimumDurationMs?: number;
  targetDurationMs?: number;
  excludedDeviceIds?: ReadonlySet<string>;
}): PrimeComputeQuoteCandidate {
  const minimumDurationMs = input.minimumDurationMs ?? 20 * 60_000;
  const targetDurationMs = input.targetDurationMs ?? 45 * 60_000;
  const candidates = input.devices.flatMap((device) => {
    const quote = input.hourlyQuotes.get(device.id);
    if (!quote || quote.hourlyCostUsd <= 0) return [];
    const affordableDurationMs = Math.floor(
      (input.walletBalanceUsd / quote.hourlyCostUsd) * 3_600_000,
    );
    const durationMs = Math.min(targetDurationMs, affordableDurationMs);
    if (durationMs < minimumDurationMs) return [];
    return [{
      device,
      hourlyCostUsd: quote.hourlyCostUsd,
      estimatedCostUsd: roundUsd(
        (quote.hourlyCostUsd * durationMs) / 3_600_000,
      ),
      quoteId: quote.quoteId,
      deadline: new Date(input.now.getTime() + durationMs).toISOString(),
      durationMs,
    }];
  });
  const eligibleCandidates = input.excludedDeviceIds?.size
    ? candidates.filter(
        (candidate) => !input.excludedDeviceIds!.has(candidate.device.id),
      )
    : candidates;
  if (candidates.length > 0 && eligibleCandidates.length === 0) {
    throw new Error(
      "All currently affordable Prime offerings failed provisioning within the retry cooldown.",
    );
  }
  eligibleCandidates.sort(
    (left, right) =>
      left.estimatedCostUsd - right.estimatedCostUsd
      || left.hourlyCostUsd - right.hourlyCostUsd
      || left.device.id.localeCompare(right.device.id),
  );
  const selected = eligibleCandidates[0];
  if (!selected) {
    throw new Error(
      "The available Prime wallet balance cannot cover the minimum requested runtime.",
    );
  }
  return selected;
}

function roundUsd(value: number): number {
  return Math.ceil(value * 1_000_000) / 1_000_000;
}
