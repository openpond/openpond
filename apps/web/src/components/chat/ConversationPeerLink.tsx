import { ConversationSourceIcon } from "../sidebar/ConversationSourceIcon";
import type { ChatProvider } from "@openpond/contracts";
import { ErrorToast } from "../common/ErrorToast";
import type { ChatMessage } from "../../lib/app-models";
import { useEffect, useRef, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { assertOriginalPonderDesktop } from "../ponder/ponder-local-work";

export type ConversationPeer = NonNullable<ChatMessage["taskMessage"]>["peer"];
export type ConversationPeerLinkProps = {
  peer: ConversationPeer;
  showIcon?: boolean;
  connection?: ClientConnection | null;
  onOpenSession?: (id: string) => void;
  onOpenPonder?: () => void;
};

/** Reuse the same desktop authority checks in expanded rows and compact summaries. */
export function ConversationPeerLink({peer, connection, onOpenSession, onOpenPonder, showIcon = false}: ConversationPeerLinkProps) {
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  useEffect(() => {
    scope.current++;
    return () => {
      scope.current++;
    };
  }, [connection, peer.sessionId, peer.bindingId]);
  async function openPonder() {
    if (!connection || !onOpenPonder) return;
    const current = scope.current;
    try {
      if (!peer.ponderScope) throw new Error("This message has no verified Ponder source.");
      await assertOriginalPonderDesktop(connection, peer.ponderScope);
      const binding = await apiFetch<{ bindingId: string }>(connection, "/v1/ponder", { method: "POST", body: "{}" });
      if (current !== scope.current) return;
      if (binding.bindingId !== peer.bindingId)
        throw new Error(
          "This task's original Ponder conversation is no longer active.",
        );
      setError(null);
      onOpenPonder();
    } catch (cause) {
      if (current === scope.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const canOpen = peer.kind === "ponder" ? Boolean(onOpenPonder && connection) : Boolean(onOpenSession && peer.sessionId);
  const label = <>{showIcon ? <ConversationSourceIcon session={{provider:peer.provider as ChatProvider}}/> : null}<span className="task-message-conversation-name">{peer.title}</span></>;
  return <>{canOpen ? <button type="button" className="task-message-conversation" title={peer.title}
    onClick={() => peer.kind === "ponder" ? void openPonder() : onOpenSession?.(peer.sessionId)}>{label}</button>
    : <span className="task-message-direction">{label}</span>}
    {error ? <ErrorToast error={error}/> : null}</>;
}
