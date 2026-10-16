import { latestChatPlan } from "../../lib/chat-task-progress";
import { ActivityPlanCard } from "../chat/ActivityPlanCard";
import { lazy, Suspense, useMemo, type ComponentProps, type Ref, type UIEvent, type ReactNode } from "react";
import type { TaskCreationSnapshot } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { useNewMessageIds } from "../../hooks/useNewMessageIds";
import { useSessionTurnCache } from "../../hooks/useSessionTurnCache";
import { buildChatTimelineRows, chatTimelineMessages, type ChatTimelineMessageRow } from "../../lib/chat-timeline-rows";
import { ConversationFormalReview } from "../human-review/ConversationFormalReview";
import { ChatTimelineEntry } from "../chat/ChatTimelineEntry";
import { MessageRow } from "../chat/Messages";

const TrainingStatusReceipt = lazy(() =>
  import("../training/TrainingCreationPanel").then((module) => ({
    default: module.TrainingStatusReceipt,
  })),
);

type MessageRowProps = ComponentProps<typeof MessageRow>;

export function MainChatThread({
  formalReviewTeamId,
  formalReviewActorId,
  formalReviewScopeKey,
  onFormalReviewOpen,
  accountBaseUrl = null,
  activeWorkspaceAppId = null,
  billingOrganizationSlug = null,
  billingTeamId = null,
  connection = null,
  conversationKey,
  creation = null,
  onOpenBrowserLink,
  onOpenAttachmentInSidebar,
  onOpenFileInSidebar,
  onOpenProfileSettings,
  onResolveUserQuestion,
  onOpenSession,
  onOpenPonder,
  onScroll,
  rows,
  sessionId,
  turnRunning,
  userAttachmentDisplay = "full",
  threadRef,
  workspaceRootPath = null,
  beforeMessages,
  afterMessages,
  loading = false,
  label = "Conversation",
  renderMessage,
  usageSessionId = sessionId,
}: {
  formalReviewTeamId?: string | null;
  formalReviewActorId?: string | null;
  formalReviewScopeKey?: string;
  onFormalReviewOpen?: () => void;
  accountBaseUrl?: string | null;
  activeWorkspaceAppId?: string | null;
  billingOrganizationSlug?: string | null;
  billingTeamId?: string | null;
  connection?: ClientConnection | null;
  conversationKey: string;
  creation?: TaskCreationSnapshot | null;
  onOpenBrowserLink?: MessageRowProps["onOpenBrowserLink"];
  onOpenAttachmentInSidebar?: MessageRowProps["onOpenAttachmentInSidebar"];
  onOpenFileInSidebar?: MessageRowProps["onOpenFileInSidebar"];
  onOpenProfileSettings?: MessageRowProps["onOpenProfileSettings"];
  onResolveUserQuestion?: MessageRowProps["onResolveUserQuestion"];
  onOpenSession?: MessageRowProps["onOpenSession"];
  onOpenPonder?: MessageRowProps["onOpenPonder"];
  onScroll: (event: UIEvent<HTMLElement>) => void;
  rows: ReturnType<typeof buildChatTimelineRows>;
  sessionId: string | null;
  turnRunning: boolean;
  userAttachmentDisplay?: NonNullable<MessageRowProps["userAttachmentDisplay"]>;
  threadRef: Ref<HTMLElement>;
  workspaceRootPath?: string | null;
  beforeMessages?: ReactNode;
  afterMessages?: ReactNode;
  loading?: boolean;
  label?: string;
  renderMessage?: (row: ChatTimelineMessageRow) => ReactNode;
  usageSessionId?: string | null;
}) {
  const messages = useMemo(() => chatTimelineMessages(rows), [rows]);
  const currentPlan = useMemo(() => latestChatPlan(messages), [messages]);
  const newMessageIds = useNewMessageIds(messages, conversationKey);
  const latestTurnId = latestMessageTurnId(messages);
  const turnCache = useSessionTurnCache({
    connection,
    latestTurnId,
    sessionId: usageSessionId,
    turnRunning,
  });

  return (
    <>
      <section
        className="chat-thread"
        aria-label={label}
        aria-busy={loading}
        ref={threadRef}
        onScroll={onScroll}
      >
        {beforeMessages}
        {rows.map((row) => (
          <ChatTimelineEntry
            key={row.id}
            row={row}
            renderMessage={(row) => renderMessage?.(row) ?? (
              <MessageRow
                activeWorkspaceAppId={activeWorkspaceAppId}
                accountBaseUrl={accountBaseUrl}
                billingOrganizationSlug={billingOrganizationSlug}
                billingTeamId={billingTeamId}
                connection={connection}
                animateInitialContent={
                  row.message.role === "assistant" && newMessageIds.has(row.message.id)
                }
                key={row.id}
                kvCacheSummary={
                  row.message.footerCacheSummary ?? (row.showFooter && row.message.turnId
                    ? (turnCache.get(row.message.turnId) ?? null)
                    : null)
                }
                message={row.message}
                onOpenAttachmentInSidebar={onOpenAttachmentInSidebar}
                onOpenFileInSidebar={onOpenFileInSidebar}
                onOpenBrowserLink={onOpenBrowserLink}
                onOpenProfileSettings={onOpenProfileSettings}
                onResolveUserQuestion={onResolveUserQuestion}
                onOpenSession={onOpenSession}
                onOpenPonder={onOpenPonder}
                userAttachmentDisplay={userAttachmentDisplay}
                workspaceRootPath={workspaceRootPath}
                showFooter={row.showFooter}
              />
            )}
          />
        ))}
        {afterMessages}
        {connection &&
        formalReviewTeamId &&
        formalReviewActorId &&
        formalReviewScopeKey &&
        sessionId &&
        onFormalReviewOpen ? (
          <ConversationFormalReview
            key={formalReviewScopeKey + sessionId}
            connection={connection}
            teamId={formalReviewTeamId}
            actorId={formalReviewActorId}
            scopeKey={formalReviewScopeKey}
            sessionId={sessionId}
            running={turnRunning}
            onOpen={onFormalReviewOpen}
          />
        ) : null}
        {creation ? (
          <Suspense fallback={null}>
            <TrainingStatusReceipt creation={creation} />
          </Suspense>
        ) : null}
      </section>
      {turnRunning && currentPlan?.length ? (
        <aside className="chat-plan-dock" aria-label="Current task progress">
          <ActivityPlanCard entries={currentPlan} initiallyExpanded={false} />
        </aside>
      ) : null}
    </>
  );
}

function latestMessageTurnId(messages: Array<{ turnId?: string }>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnId = messages[index]?.turnId;
    if (turnId) return turnId;
  }
  return null;
}
