import type { Session } from "@openpond/contracts";

/** OpenPond's native tool loop retains its canonical local task and event history. */
export function localManagedSessionId(session: Session): string | null {
  if (session.provider === "openpond") return session.id;
  if (session.provider === "codex") return session.codexThreadId;
  return session.nativeAgent?.sessionId ?? null;
}

export function localManagedProviderSupported(provider: Session["provider"]): boolean {
  return ["openpond", "codex", "claude-code", "opencode", "grok-build"].includes(provider);
}
