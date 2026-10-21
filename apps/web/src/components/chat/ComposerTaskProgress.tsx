import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ChatMessage } from "../../lib/app-models";
import { currentChatTaskProgress, type ChatTaskProgress } from "../../lib/chat-task-progress";
import { ActivityPlanCard } from "./ActivityPlanCard";

const TaskProgressContext = createContext<ChatTaskProgress | null>(null);

export function TaskProgressProvider({ messages, enabled, conversationKey, children }: {
  messages: ChatMessage[];
  enabled: boolean;
  conversationKey: string;
  children: ReactNode;
}) {
  const progress = useMemo(() => {
    const current = enabled ? currentChatTaskProgress(messages) : null;
    return current ? { ...current, scopeKey: `${conversationKey}:${current.scopeKey}` } : null;
  }, [messages, enabled, conversationKey]);
  return <TaskProgressContext.Provider value={progress}>{children}</TaskProgressContext.Provider>;
}

export function useDockedTaskProgress() {
  return useContext(TaskProgressContext);
}

export function ComposerTaskProgress() {
  const progress = useDockedTaskProgress();
  if (!progress) return null;
  return <div className="composer-task-progress">
    <ActivityPlanCard key={progress.scopeKey} entries={progress.entries} />
  </div>;
}
