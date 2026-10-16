import type { Session } from "@openpond/contracts";

export const NATIVE_WORKER_READ_ONLY_REASON = "This native agent is controlled by its parent conversation. You can inspect its transcript; send further instructions through the parent conversation.";

/** Native parent-owned agents cannot accept independent desktop turn admission. */
export function assertNativeWorkerDirectInput(session: Session): void {
  if (session.metadata?.nativeWorker === true && session.metadata.nativeWorkerCanResume === false)
    throw new Error(NATIVE_WORKER_READ_ONLY_REASON);
}
