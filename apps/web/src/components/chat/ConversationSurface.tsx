import {lazy, Suspense, type ComponentProps, type ReactNode} from "react";
import type {MainChatThread as ThreadComponent} from "../app-shell/MainChatThread";
import {MessageNavigationControls} from "../app-shell/MainPaneControls";
import {useMainPaneChatScroll} from "../app-shell/useMainPaneChatScroll";

const MainChatThread = lazy(() => import("../app-shell/MainChatThread").then(module => ({default: module.MainChatThread})));

type ScrollOptions = Omit<Parameters<typeof useMainPaneChatScroll>[0], "groupInProgressWork">;
type ThreadOptions = Omit<ComponentProps<typeof ThreadComponent>,
  "rows" | "threadRef" | "onScroll" | "sessionId" | "conversationKey" | "turnRunning">;

/** One thread, scroll lifecycle and composer dock for ordinary chats and coordinators. */
export function ConversationSurface({scroll: options, thread, composer, composerPrefix, hasApproval = false, className = ""}: {
  scroll: ScrollOptions;
  thread?: ThreadOptions;
  composer?: ReactNode;
  composerPrefix?: ReactNode;
  hasApproval?: boolean;
  className?: string;
}) {
  const scroll = useMainPaneChatScroll({...options, groupInProgressWork: true});
  return <div className={`chat-column ${hasApproval ? "has-approval" : ""} ${className}`} style={scroll.chatColumnStyle}>
    <Suspense fallback={null}><MainChatThread {...thread} rows={scroll.chatTimelineRows} threadRef={scroll.chatThreadRef}
      onScroll={event => scroll.handleChatScroll(event.currentTarget)} sessionId={options.browserConversationId}
      conversationKey={options.browserConversationId ?? "draft"} turnRunning={options.turnRunning}/></Suspense>
    <div className={`composer-stack dock ${hasApproval ? "has-approval" : ""}`} ref={scroll.composerStackRef}>
      {composerPrefix}
      {scroll.showScrollToBottomButton && !scroll.chatThreadPreparingInitialScroll ? <MessageNavigationControls
        canGoNext={scroll.userMessageNavigation.canGoNext} canGoPrevious={scroll.userMessageNavigation.canGoPrevious}
        onJumpToLatest={scroll.jumpToLatestChatMessage}
        onNext={() => {if (scroll.userMessageNavigation.canGoNext) scroll.goToUserMessage("next");}}
        onPrevious={() => {if (scroll.userMessageNavigation.canGoPrevious) scroll.goToUserMessage("previous");}}/> : null}
      {composer}
    </div>
  </div>;
}
