import { useEffect } from "react";
import type { ClientConnection } from "../api";
import { CHAT_CONTEXT_SELECTED, useChatContextSelection } from "./useChatContextSelection";

/** Resolve the tab label; only an explicit context selection opens Training. */
export function useTrainingSidebarContext({ connection, sessionId, accountScope, active, onOpen }: {
  connection: ClientConnection | null; sessionId: string | null; accountScope: string; active: boolean; onOpen: () => void;
}) {
  const context = useChatContextSelection(active ? connection : null, sessionId, accountScope);
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
