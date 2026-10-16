import { isManagedLocalChatProvider } from "../../openpond/managed-chat-provider-id.js";
import { isRegisteredAcpProvider, type Session } from "@openpond/contracts";

/** OpenPond's native tool loop retains its canonical local task and event history. */
export function localManagedSessionId(session: Session): string | null {
  if (session.provider === "openpond" || isManagedLocalChatProvider(session.provider)) return session.id;
  if (session.provider === "codex") return session.codexThreadId;
  return session.nativeAgent?.sessionId ?? null;
}

export function localManagedProviderSupported(provider: Session["provider"]): boolean {
  return isManagedLocalChatProvider(provider) || isRegisteredAcpProvider(provider) || ["openpond", "codex", "claude-code", "opencode", "grok-build"].includes(provider);
}
