export type AgentCompactionHost<TResult> = {
  started(): Promise<void>;
  compact(): Promise<TResult>;
  failed(error: unknown): Promise<void>;
};

export type AgentCompactionDecision = {
  shouldCompact: boolean;
  projectedTokens: number;
  thresholdTokens: number;
  usableContextTokens: number;
  maxContextTokens: number;
  tokenSource: "heuristic";
};

/** Owns the provider-neutral context threshold decision. */
export function agentCompactionDecision(input: {
  projectedTokens: number;
  maxContextTokens: number | null;
  usableContextTokens: number | null;
  triggerPercent?: number;
}): AgentCompactionDecision {
  if (!input.maxContextTokens || !input.usableContextTokens) {
    return {
      shouldCompact: false,
      projectedTokens: input.projectedTokens,
      thresholdTokens: Number.MAX_SAFE_INTEGER,
      usableContextTokens: 0,
      maxContextTokens: 0,
      tokenSource: "heuristic",
    };
  }
  const triggerRatio = Math.max(0.01, Math.min(1, (input.triggerPercent ?? 85) / 100));
  const thresholdTokens = Math.max(1, Math.floor(input.usableContextTokens * triggerRatio));
  return {
    shouldCompact: input.projectedTokens >= thresholdTokens,
    projectedTokens: input.projectedTokens,
    thresholdTokens,
    usableContextTokens: input.usableContextTokens,
    maxContextTokens: input.maxContextTokens,
    tokenSource: "heuristic",
  };
}

/**
 * Owns the transport-neutral compaction lifecycle while the host supplies
 * persistence, provider access, and its native or summary implementation.
 */
export async function runAgentCompaction<TResult>(
  host: AgentCompactionHost<TResult>,
): Promise<TResult> {
  await host.started();
  try {
    return await host.compact();
  } catch (error) {
    await host.failed(error);
    throw error;
  }
}
