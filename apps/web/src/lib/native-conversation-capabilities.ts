import type { Session } from "@openpond/contracts";

/** Current capability denial cannot be cleared by replaying an older session event. */
export function resolveNativeConversationAvailability(input: {
  sessionId: string | null; current?: Session | null; observed?: Session | null; fallbackReason: string | null;
}) {
  const current = input.current?.id === input.sessionId ? input.current : null;
  const observed = input.observed?.id === input.sessionId ? input.observed : null;
  const unsupported = [current, observed].find(session => session?.metadata?.nativeWorker === true && session.metadata.nativeWorkerCanResume === false);
  const session = unsupported ?? observed ?? current;
  const recordedReason = typeof session?.metadata?.nativeReadOnlyReason === "string" ? session.metadata.nativeReadOnlyReason : null;
  return { session, reason: unsupported ? recordedReason ?? "This native agent is controlled by its parent conversation. Send further instructions through the parent conversation." : session ? recordedReason : input.fallbackReason };
}
