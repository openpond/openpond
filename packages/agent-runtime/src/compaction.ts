export type AgentCompactionHost<TResult> = {
  started(): Promise<void>;
  compact(): Promise<TResult>;
  failed(error: unknown): Promise<void>;
};

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
