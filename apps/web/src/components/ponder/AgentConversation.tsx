import type { ReactNode } from "react";
import type { ClientConnection } from "../../api/api-client";
import type { ChatMessage } from "../../lib/app-models";
import { ConversationSurface } from "../chat/ConversationSurface";
/** The same timeline, messages and scrolling as the main conversation, in a read-only pane. */
export function AgentConversation({connection, conversationId, messages, loading, running, hasMore = false, loadOlder, children, usageSessionId = conversationId}: {
  connection: ClientConnection; conversationId: string; messages: ChatMessage[]; loading: boolean; running: boolean;
  hasMore?: boolean; loadOlder?: () => Promise<boolean>; children?: ReactNode; usageSessionId?: string | null;
}) {
  return <ConversationSurface className="ponder-agent-conversation" scroll={{browserConversationId: conversationId, chatSubmissionVersion: 0,
    chatMessages: messages, chatHistoryHasMore: hasMore, chatHistoryLoading: loading, onLoadMoreChatHistory: loadOlder,
    pendingApproval: null, showChatThread: true, showThinkingIndicator: running, turnRunning: running, view: "chat"}}
    thread={{connection, usageSessionId, label:"Agent conversation", loading, afterMessages:children}}/>;
}
