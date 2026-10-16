import type { Session } from "@openpond/contracts";

/** Resolve provider identities to desktop ids without conflating parentage and ownership. */
export function resolveNativeWorkerParents(workers: readonly Session[], sessions: readonly Session[]): Session[] {
  return workers.map(child => {
    const nativeParent = child.metadata?.nativeParentSessionId;
    if (typeof nativeParent !== "string") return child;
    const parent = sessions.find(candidate => candidate.id !== child.id && candidate.provider === child.provider &&
      (candidate.codexThreadId === nativeParent || candidate.nativeAgent?.sessionId === nativeParent || candidate.metadata?.nativeSessionId === nativeParent) &&
      (child.provider === "codex" || (Boolean(child.metadata?.sourceInstanceId) && candidate.metadata?.sourceInstanceId === child.metadata?.sourceInstanceId)));
    return parent ? { ...child, parentSessionId: parent.id } : child;
  });
}
