import {
  lazy,
  Suspense,
  useMemo,
  type ComponentProps,
  type Ref,
  type UIEvent,
} from "react";
import type { TaskCreationSnapshot } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { useNewMessageIds } from "../../hooks/useNewMessageIds";
import { useSessionTurnCache } from "../../hooks/useSessionTurnCache";
import {
  buildChatTimelineRows,
  isLatestAssistantMessageForTurn,
  latestAssistantMessageIdsByTurn,
} from "../../lib/chat-timeline-rows";
import { MessageRow, ThinkingIndicator } from "../chat/Messages";

const TrainingStatusReceipt = lazy(() =>
  import("../training/TrainingCreationPanel").then((module) => ({
    default: module.TrainingStatusReceipt,
  })),
);

type MessageRowProps = ComponentProps<typeof MessageRow>;

export function MainChatThread({
  accountBaseUrl,
  activeWorkspaceAppId,
  billingOrganizationSlug,
  billingTeamId,
  connection,
  conversationKey,
  creation,
  onOpenBrowserLink,
  onOpenAttachmentInSidebar,
  onOpenFileInSidebar,
  onOpenProfileSettings,
  onResolveUserQuestion,
  onOpenSession,
  onScroll,
  rows,
  sessionId,
  turnRunning,
  userAttachmentDisplay,
  threadRef,
  workspaceRootPath,
}: {
  accountBaseUrl: string | null;
  activeWorkspaceAppId: string | null;
  billingOrganizationSlug: string | null;
  billingTeamId: string | null;
  connection: ClientConnection | null;
  conversationKey: string;
  creation: TaskCreationSnapshot | null;
  onOpenBrowserLink: MessageRowProps["onOpenBrowserLink"];
  onOpenAttachmentInSidebar: MessageRowProps["onOpenAttachmentInSidebar"];
  onOpenFileInSidebar: MessageRowProps["onOpenFileInSidebar"];
  onOpenProfileSettings: MessageRowProps["onOpenProfileSettings"];
  onResolveUserQuestion: MessageRowProps["onResolveUserQuestion"];
  onOpenSession: MessageRowProps["onOpenSession"];
  onScroll: (event: UIEvent<HTMLElement>) => void;
  rows: ReturnType<typeof buildChatTimelineRows>;
  sessionId: string | null;
  turnRunning: boolean;
  userAttachmentDisplay: NonNullable<MessageRowProps["userAttachmentDisplay"]>;
  threadRef: Ref<HTMLElement>;
  workspaceRootPath: string | null;
}) {
  const messages = useMemo(
    () =>
      rows.flatMap((row) =>
        row.type === "message" ? [row.message] : []
      ),
    [rows]
  );
  const newMessageIds = useNewMessageIds(messages, conversationKey);
  const latestTurnId = latestMessageTurnId(messages);
  const latestAssistantByTurn = useMemo(
    () => latestAssistantMessageIdsByTurn(messages),
    [messages],
  );
  const turnCache = useSessionTurnCache({
    connection,
    latestTurnId,
    sessionId,
    turnRunning,
  });

  return (
    <section
      className="chat-thread"
      aria-label="Conversation"
      ref={threadRef}
      onScroll={onScroll}
    >
      {rows.map((row) => row.type === "thinking" ? (
        <ThinkingIndicator key={row.id} />
      ) : (
        <MessageRow
          activeWorkspaceAppId={activeWorkspaceAppId}
          accountBaseUrl={accountBaseUrl}
          billingOrganizationSlug={billingOrganizationSlug}
          billingTeamId={billingTeamId}
          connection={connection}
          animateInitialContent={
            row.message.role === "assistant" &&
            newMessageIds.has(row.message.id)
          }
          key={row.id}
          kvCacheSummary={
            isLatestAssistantMessageForTurn(row.message, latestAssistantByTurn) && row.message.turnId
              ? turnCache.get(row.message.turnId) ?? null
              : null
          }
          message={row.message}
          onOpenAttachmentInSidebar={onOpenAttachmentInSidebar}
          onOpenFileInSidebar={onOpenFileInSidebar}
          onOpenBrowserLink={onOpenBrowserLink}
          onOpenProfileSettings={onOpenProfileSettings}
          onResolveUserQuestion={onResolveUserQuestion}
          onOpenSession={onOpenSession}
          userAttachmentDisplay={userAttachmentDisplay}
          workspaceRootPath={workspaceRootPath}
          showFooter={row.showFooter}
        />
      ))}
      {creation ? (
        <Suspense fallback={null}>
          <TrainingStatusReceipt creation={creation} />
        </Suspense>
      ) : null}
    </section>
  );
}

function latestMessageTurnId(messages: Array<{ turnId?: string }>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnId = messages[index]?.turnId;
    if (turnId) return turnId;
  }
  return null;
}
