import type { CodexAppServerClient } from "@openpond/codex-provider";

export class CodexTurnSettlementError extends AggregateError {}

/** A failed observer must settle the producer before its evidence is sealed. */
export async function awaitCodexTurn(input: {
  client: Pick<CodexAppServerClient, "waitForTurn" | "stopAndWait">;
  turnId: string;
  signal: AbortSignal;
  timeoutMs?: number;
  stop?: () => Promise<void>;
  flush?: () => Promise<void>;
}): Promise<void> {
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(input.signal.reason ?? new Error("Turn interrupted."));
    input.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    input.signal.throwIfAborted();
    await Promise.race([input.client.waitForTurn(input.turnId, input.timeoutMs), interrupted]);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await (input.stop ? input.stop() : input.client.stopAndWait());
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await input.flush?.();
    } catch (retentionError) {
      failures.push(retentionError);
    }
    if (failures.length > 1) {
      throw new CodexTurnSettlementError(failures, failures.map(failure =>
        failure instanceof Error ? failure.message : String(failure)).join("; "));
    }
    throw error;
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}
