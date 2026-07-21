import { lazy, Suspense, type ComponentProps, type RefObject, type UIEvent } from "react";
import type { TaskCreationSnapshot } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { buildChatTimelineRows } from "../../lib/chat-timeline-rows";
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
  creation,
  onOpenBrowserLink,
  onOpenFileInSidebar,
  onOpenProfileSettings,
  onOpenSession,
  onScroll,
  preparingInitialScroll,
  rows,
  threadRef,
  workspaceRootPath,
}: {
  accountBaseUrl: string | null;
  activeWorkspaceAppId: string | null;
  billingOrganizationSlug: string | null;
  billingTeamId: string | null;
  connection: ClientConnection | null;
  creation: TaskCreationSnapshot | null;
  onOpenBrowserLink: MessageRowProps["onOpenBrowserLink"];
  onOpenFileInSidebar: MessageRowProps["onOpenFileInSidebar"];
  onOpenProfileSettings: MessageRowProps["onOpenProfileSettings"];
  onOpenSession: MessageRowProps["onOpenSession"];
  onScroll: (event: UIEvent<HTMLElement>) => void;
  preparingInitialScroll: boolean;
  rows: ReturnType<typeof buildChatTimelineRows>;
  threadRef: RefObject<HTMLElement | null>;
  workspaceRootPath: string | null;
}) {
  return (
    <section
      className={`chat-thread${preparingInitialScroll ? " initial-scroll-pending" : ""}`}
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
          key={row.id}
          message={row.message}
          onOpenFileInSidebar={onOpenFileInSidebar}
          onOpenBrowserLink={onOpenBrowserLink}
          onOpenProfileSettings={onOpenProfileSettings}
          onOpenSession={onOpenSession}
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
