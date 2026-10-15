import { useEffect, useRef } from "react";
import type { ClientConnection } from "../api";
import { CHAT_CONTEXT_SELECTED, useChatContextSelection } from "./useChatContextSelection";

/** Follow canonical context changes without reopening the tool on status polls. */
export function useTrainingSidebarContext({ connection, sessionId, accountScope, active, onOpen }: {
  connection: ClientConnection | null; sessionId: string | null; accountScope: string; active: boolean; onOpen: () => void;
}) {
  const context = useChatContextSelection(active ? connection : null, sessionId, accountScope);
  const seen = useRef("");
  const targetKey = context.selection ? JSON.stringify(context.selection.target) : "";
  useEffect(() => {
    const key = `${context.scope}:${sessionId ?? "new"}:${targetKey}`;
    if (!active || !targetKey || context.selecting || seen.current === key) return;
    seen.current = key;
    onOpen();
  }, [active, sessionId, context.scope, context.selecting, targetKey, onOpen]);
  useEffect(() => {
    const selected = (event: Event) => {
      const detail = (event as CustomEvent<{sessionId:string|null;scope:string;targetKey:string}>).detail;
      if (!active || detail?.sessionId !== sessionId || detail.scope !== context.scope) return;
      seen.current = `${context.scope}:${sessionId ?? "new"}:${detail.targetKey}`;
      onOpen();
    };
    window.addEventListener(CHAT_CONTEXT_SELECTED, selected);
    return () => window.removeEventListener(CHAT_CONTEXT_SELECTED, selected);
  }, [active, sessionId, context.scope, onOpen]);
  return context.selection?.target.kind === "dataset" ? "Experiment draft"
    : context.selection?.model?.name ?? context.selection?.label ?? "Training";
}
