import type { ChatMessage } from "../../lib/app-models";
import { MessageFooter } from "./MessageFooter";
import { UserMessageContent } from "./UserMessageContent";
import { useEffect, useRef, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { assertOriginalPonderDesktop } from "../ponder/ponder-local-work";

/** Delivery state is transport evidence, never a claim of understanding/reply. */
export function TaskMessageRow({
  message,
  onOpenSession,
  onOpenPonder,
  connection,
}: {
  message: ChatMessage;
  onOpenSession?: (id: string) => void;
  onOpenPonder?: () => void;
  connection?: ClientConnection | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  useEffect(() => {
    scope.current++;
    return () => {
      scope.current++;
    };
  }, [connection, message.id]);
  const delivery = message.taskMessage;
  if (!delivery) return null;
  const { input, peer, direction } = delivery;
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
  const state = input.error
    ? input.error
    : {
        pending: "Queued",
        included: "Included in agent request",
        resolved: "Delivered to agent",
        rejected: "Not delivered",
        cancelled: "Cancelled",
      }[input.state];
  return (
    <article className="message-row user task-message-row">
      <div className="user-message">
        <UserMessageContent content={input.body} />
      </div>
      <div className="task-message-attribution">
        <span>{direction === "sent" ? "Sent to" : "Received from"}</span>
        {peer.kind === "ponder" ? (
          onOpenPonder && connection ? (
            <button type="button" onClick={() => void openPonder()}>
              {peer.title}
            </button>
          ) : (
            <span>{peer.title}</span>
          )
        ) : onOpenSession ? (
          <button type="button" onClick={() => onOpenSession(peer.sessionId)}>
            {peer.title}
          </button>
        ) : (
          <span>{peer.title}</span>
        )}
        <span title={`Delivery receipt ${input.id}`} role="status">
          {state}
        </span>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <MessageFooter content={input.body} timestamp={message.timestamp} />
    </article>
  );
}
