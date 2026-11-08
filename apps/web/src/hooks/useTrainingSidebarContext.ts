import { useEffect, useRef } from "react";
import type { ClientConnection } from "../api";
import { CHAT_CONTEXT_SELECTED, useChatContextSelection } from "./useChatContextSelection";

/** Reopen a scoped selection after new-chat handoff, even if its selection
 * event arrived before the destination chat mounted. Status polls do not reopen it. */
export function useTrainingSidebarContext({ connection, sessionId, accountScope, active, onOpen }: {
  connection: ClientConnection | null; sessionId: string | null; accountScope: string; active: boolean; onOpen: () => void;
}) {
  const context = useChatContextSelection(active ? connection : null, sessionId, accountScope);
  const revealed = useRef<string | null>(null);
  const selection = context.selection;
  const revealKey = selection ? JSON.stringify([context.scope, sessionId, selection.target,
    selection.resource?.id, selection.resource?.revision, selection.dataset?.id, selection.dataset?.revision]) : null;
  useEffect(() => {
    if (!active || !revealKey || revealed.current === revealKey) return;
    revealed.current = revealKey;
    onOpen();
  }, [active, revealKey, onOpen]);
  useEffect(() => {
    const selected = (event: Event) => {
      const detail = (event as CustomEvent<{sessionId:string|null;scope:string;targetKey:string}>).detail;
      if (!active || detail?.sessionId !== sessionId || detail.scope !== context.scope) return;
      onOpen();
    };
    window.addEventListener(CHAT_CONTEXT_SELECTED, selected);
    return () => window.removeEventListener(CHAT_CONTEXT_SELECTED, selected);
  }, [active, sessionId, context.scope, onOpen]);
  return context.selection?.target.kind === "dataset" ? "Experiment draft"
    : context.selection?.model?.name ?? context.selection?.label ?? "Ponder";
}
