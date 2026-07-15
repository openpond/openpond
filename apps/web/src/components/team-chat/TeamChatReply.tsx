import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { TeamChatMessage } from "@openpond/contracts";
import type { TeamChatReplyTarget } from "../../lib/team-chat-reply";
import { teamChatReplySnippet } from "../../lib/team-chat-reply";
import { Reply, X } from "../icons";

export type TeamChatReplyMenuState = {
  message: TeamChatMessage;
  x: number;
  y: number;
};

export function TeamChatComposerReply(props: {
  authorLabel: string;
  target: TeamChatReplyTarget;
  onCancel: () => void;
  onJump: () => void;
}) {
  return (
    <div className="team-chat-composer-reply" role="status">
      <Reply size={15} aria-hidden="true" />
      <button
        type="button"
        className="team-chat-composer-reply-target"
        aria-label={`Jump to message from ${props.authorLabel}`}
        onClick={props.onJump}
      >
        <strong>Replying to {props.authorLabel}</strong>
        <span>{teamChatReplySnippet(props.target)}</span>
      </button>
      <button
        type="button"
        className="team-chat-icon-button"
        aria-label="Cancel reply"
        data-tooltip="Cancel reply"
        onClick={props.onCancel}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function TeamChatMessageReplyQuote(props: {
  authorLabel: string;
  target: TeamChatReplyTarget;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      className="team-chat-message-reply-quote"
      aria-label={`Jump to replied message from ${props.authorLabel}`}
      onClick={props.onJump}
    >
      <strong>{props.authorLabel}</strong>
      <span>{teamChatReplySnippet(props.target)}</span>
    </button>
  );
}

export function TeamChatReplyContextMenu(props: {
  menu: TeamChatReplyMenuState | null;
  onClose: () => void;
  onReply: (message: TeamChatMessage) => void;
}) {
  const replyButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!props.menu) return undefined;
    replyButtonRef.current?.focus();
    const close = () => props.onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [props.menu, props.onClose]);

  if (!props.menu || typeof document === "undefined") return null;
  const menu = (
    <div
      className="team-chat-message-context-menu"
      role="menu"
      aria-label="Message actions"
      style={{ left: props.menu.x, top: props.menu.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={replyButtonRef}
        type="button"
        role="menuitem"
        onClick={() => {
          props.onReply(props.menu!.message);
          props.onClose();
        }}
      >
        <Reply size={14} />
        Reply
      </button>
    </div>
  );
  return createPortal(menu, document.body);
}

export function teamChatReplyMenuPosition(input: {
  clientX: number;
  clientY: number;
  fallbackX: number;
  fallbackY: number;
  viewportWidth: number;
  viewportHeight: number;
}): { x: number; y: number } {
  const width = 150;
  const height = 42;
  const margin = 8;
  const requestedX = input.clientX || input.fallbackX;
  const requestedY = input.clientY || input.fallbackY;
  return {
    x: Math.max(
      margin,
      Math.min(requestedX, input.viewportWidth - width - margin),
    ),
    y: Math.max(
      margin,
      Math.min(requestedY, input.viewportHeight - height - margin),
    ),
  };
}

export function teamChatMessageDomId(messageId: string): string {
  return `team-chat-message-${encodeURIComponent(messageId)}`;
}
