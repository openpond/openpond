import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ChatMessage } from "../../lib/app-models";
import { buildChatTimelineRows } from "../../lib/chat-timeline-rows";
import {
  CHAT_HISTORY_TOP_THRESHOLD_PX,
  CHAT_USER_MESSAGE_SCROLL_OFFSET_PX,
  EMPTY_USER_MESSAGE_NAVIGATION,
  easeInOutCubic,
  easedChatScrollDuration,
  isNearChatBottom,
  messageScrollTop,
  nextUserMessageTarget,
  userMessageNavigationState,
  type UserMessageNavigationState,
} from "./main-pane-helpers";
import type { MainPaneProps } from "./main-pane-types";

export function useMainPaneChatScroll({
  browserConversationId,
  chatHistoryHasMore,
  chatHistoryLoading,
  chatMessages,
  onLoadMoreChatHistory,
  pendingApproval,
  showChatThread,
  showThinkingIndicator,
  view,
}: {
  browserConversationId: string | null;
  chatHistoryHasMore: boolean;
  chatHistoryLoading: boolean;
  chatMessages: ChatMessage[];
  onLoadMoreChatHistory?: () => Promise<boolean>;
  pendingApproval: MainPaneProps["pendingApproval"];
  showChatThread: boolean;
  showThinkingIndicator: boolean;
  view: MainPaneProps["view"];
}) {
  const chatThreadRef = useRef<HTMLElement | null>(null);
  const composerStackRef = useRef<HTMLDivElement | null>(null);
  const stickyChatScrollRef = useRef(true);
  const previousConversationKeyRef = useRef<string | null>(null);
  const pendingChatScrollRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const remoteHistoryLoadPendingRef = useRef(false);
  const initialChatScrollPendingRef = useRef(false);
  const autoChatScrollPendingRef = useRef(false);
  const autoChatScrollFrameRef = useRef<number | null>(null);
  const smoothChatScrollFrameRef = useRef<number | null>(null);
  const [initialChatScrollVersion, setInitialChatScrollVersion] = useState(0);
  const [initialChatScrollReadyKey, setInitialChatScrollReadyKey] = useState<
    string | null
  >(null);
  const [showScrollToBottomButton, setShowScrollToBottomButton] =
    useState(false);
  const [chatComposerReservePx, setChatComposerReservePx] = useState(132);
  const [userMessageNavigation, setUserMessageNavigation] =
    useState<UserMessageNavigationState>(EMPTY_USER_MESSAGE_NAVIGATION);
  const chatTimelineRows = useMemo(
    () => buildChatTimelineRows(chatMessages, { showThinkingIndicator }),
    [chatMessages, showThinkingIndicator]
  );
  const chatColumnStyle = useMemo(
    () =>
      ({
        "--chat-composer-reserve": `${chatComposerReservePx}px`,
      } as CSSProperties),
    [chatComposerReservePx]
  );
  const latestChatMessage = chatMessages.at(-1);
  const chatScrollContentKey = [
    chatTimelineRows.length,
    latestChatMessage?.id ?? "",
    latestChatMessage?.content?.length ?? 0,
    latestChatMessage?.timestamp ?? "",
    showThinkingIndicator ? "thinking" : "",
  ].join(":");
  const canLoadOlderChatMessages = chatHistoryHasMore;
  const conversationKey = browserConversationId;
  const chatThreadPreparingInitialScroll =
    view === "chat" &&
    showChatThread &&
    Boolean(conversationKey) &&
    initialChatScrollReadyKey !== conversationKey;
  const setChatAwayFromBottom = useCallback((awayFromBottom: boolean) => {
    setShowScrollToBottomButton((current) =>
      current === awayFromBottom ? current : awayFromBottom
    );
  }, []);
  const setUserMessageNavigationState = useCallback(
    (state: UserMessageNavigationState) => {
      setUserMessageNavigation((current) =>
        current.canGoPrevious === state.canGoPrevious &&
        current.canGoNext === state.canGoNext
          ? current
          : state
      );
    },
    []
  );
  const updateChatScrollControls = useCallback(
    (element: HTMLElement, options: { nearBottom?: boolean } = {}) => {
      const nearBottom = options.nearBottom ?? isNearChatBottom(element);
      setChatAwayFromBottom(!nearBottom);
      setUserMessageNavigationState(userMessageNavigationState(element));
    },
    [setChatAwayFromBottom, setUserMessageNavigationState]
  );
  const finishInitialChatScroll = useCallback(
    (key: string | null) => {
      const wasPending = initialChatScrollPendingRef.current;
      initialChatScrollPendingRef.current = false;
      setInitialChatScrollReadyKey(key);
      setChatAwayFromBottom(false);
      setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
      if (wasPending) setInitialChatScrollVersion((version) => version + 1);
    },
    [setChatAwayFromBottom, setUserMessageNavigationState]
  );
  const cancelSmoothChatScroll = useCallback(() => {
    if (
      smoothChatScrollFrameRef.current === null ||
      typeof window === "undefined"
    )
      return;
    window.cancelAnimationFrame(smoothChatScrollFrameRef.current);
    smoothChatScrollFrameRef.current = null;
  }, []);
  const smoothScrollChatTo = useCallback(
    (
      element: HTMLElement,
      targetScrollTop: number | (() => number),
      onSettled?: () => void
    ) => {
      cancelSmoothChatScroll();
      const maxScrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight
      );
      const readTarget = () => {
        const nextTarget =
          typeof targetScrollTop === "function"
            ? targetScrollTop()
            : targetScrollTop;
        return Math.max(
          0,
          Math.min(
            nextTarget,
            Math.max(0, element.scrollHeight - element.clientHeight)
          )
        );
      };
      const target = Math.max(0, Math.min(readTarget(), maxScrollTop));
      const start = element.scrollTop;
      const distance = target - start;
      const reduceMotion =
        typeof window === "undefined" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ===
          true;

      if (reduceMotion || Math.abs(distance) < 1) {
        element.scrollTop = target;
        onSettled?.();
        return;
      }

      const duration = easedChatScrollDuration(distance);
      const startTime = window.performance.now();
      const step = (now: number) => {
        if (chatThreadRef.current !== element) {
          smoothChatScrollFrameRef.current = null;
          return;
        }

        const progress = Math.min(1, (now - startTime) / duration);
        const currentTarget = readTarget();
        element.scrollTop =
          start + (currentTarget - start) * easeInOutCubic(progress);
        if (progress < 1) {
          smoothChatScrollFrameRef.current = window.requestAnimationFrame(step);
          return;
        }

        element.scrollTop = readTarget();
        smoothChatScrollFrameRef.current = null;
        onSettled?.();
      };

      smoothChatScrollFrameRef.current = window.requestAnimationFrame(step);
    },
    [cancelSmoothChatScroll]
  );
  const cancelScheduledChatBottomScroll = useCallback(() => {
    autoChatScrollPendingRef.current = false;
    if (
      autoChatScrollFrameRef.current === null ||
      typeof window === "undefined"
    )
      return;
    window.cancelAnimationFrame(autoChatScrollFrameRef.current);
    autoChatScrollFrameRef.current = null;
  }, []);
  const scrollChatToBottom = useCallback(
    (
      element: HTMLElement,
      options: {
        conversationKey?: string | null;
        finishInitial?: boolean;
        settle?: boolean;
      } = {}
    ) => {
      const scrollOnce = () => {
        element.scrollTop = element.scrollHeight;
      };

      scrollOnce();

      if (typeof window === "undefined") {
        if (options.finishInitial)
          finishInitialChatScroll(options.conversationKey ?? null);
        return;
      }

      cancelScheduledChatBottomScroll();
      autoChatScrollPendingRef.current = true;
      let frameCount = 0;
      let stableBottomFrames = 0;
      let lastScrollHeight = element.scrollHeight;
      const maxFrameCount = options.settle ? 12 : 2;
      const settle = () => {
        const currentElement = chatThreadRef.current;
        if (!currentElement) {
          autoChatScrollFrameRef.current = null;
          autoChatScrollPendingRef.current = false;
          if (options.finishInitial)
            finishInitialChatScroll(options.conversationKey ?? null);
          return;
        }
        currentElement.scrollTop = currentElement.scrollHeight;

        const distanceFromBottom =
          currentElement.scrollHeight -
          currentElement.scrollTop -
          currentElement.clientHeight;
        const scrollHeightStable =
          Math.abs(currentElement.scrollHeight - lastScrollHeight) <= 1;
        lastScrollHeight = currentElement.scrollHeight;
        stableBottomFrames =
          distanceFromBottom <= 1 && scrollHeightStable
            ? stableBottomFrames + 1
            : 0;
        frameCount += 1;
        if (frameCount < maxFrameCount && stableBottomFrames < 2) {
          autoChatScrollFrameRef.current = window.requestAnimationFrame(settle);
          return;
        }

        autoChatScrollFrameRef.current = null;
        autoChatScrollPendingRef.current = false;
        stickyChatScrollRef.current = true;
        setChatAwayFromBottom(false);
        setUserMessageNavigationState(
          userMessageNavigationState(currentElement)
        );
        if (options.finishInitial)
          finishInitialChatScroll(options.conversationKey ?? null);
      };
      autoChatScrollFrameRef.current = window.requestAnimationFrame(settle);
    },
    [
      cancelScheduledChatBottomScroll,
      finishInitialChatScroll,
      setChatAwayFromBottom,
      setUserMessageNavigationState,
    ]
  );
  const jumpToLatestChatMessage = useCallback(() => {
    const element = chatThreadRef.current;
    if (!element) return;
    cancelScheduledChatBottomScroll();
    stickyChatScrollRef.current = true;
    setChatAwayFromBottom(false);
    smoothScrollChatTo(
      element,
      () => element.scrollHeight - element.clientHeight,
      () => {
        if (chatThreadRef.current !== element) return;
        element.scrollTop = element.scrollHeight;
        stickyChatScrollRef.current = true;
        setChatAwayFromBottom(false);
        setUserMessageNavigationState(userMessageNavigationState(element));
      }
    );
  }, [
    cancelScheduledChatBottomScroll,
    setChatAwayFromBottom,
    setUserMessageNavigationState,
    smoothScrollChatTo,
  ]);
  const goToUserMessage = useCallback(
    (direction: "previous" | "next") => {
      const element = chatThreadRef.current;
      if (!element) return;
      const target = nextUserMessageTarget(element, direction);
      if (!target) return;

      cancelScheduledChatBottomScroll();
      const nextScrollTop = () =>
        target.isConnected
          ? Math.max(
              0,
              messageScrollTop(element, target) -
                CHAT_USER_MESSAGE_SCROLL_OFFSET_PX
            )
          : element.scrollTop;
      smoothScrollChatTo(element, nextScrollTop, () => {
        if (chatThreadRef.current !== element) return;
        const nearBottom = isNearChatBottom(element);
        stickyChatScrollRef.current = nearBottom;
        updateChatScrollControls(element, { nearBottom });
      });
    },
    [
      cancelScheduledChatBottomScroll,
      smoothScrollChatTo,
      updateChatScrollControls,
    ]
  );
  const rememberChatScrollPosition = useCallback(() => {
    const element = chatThreadRef.current;
    if (!element) return;
    pendingChatScrollRestoreRef.current = {
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
    stickyChatScrollRef.current = false;
  }, []);
  const loadOlderChatMessages = useCallback(async () => {
    if (!canLoadOlderChatMessages) return;
    if (
      !onLoadMoreChatHistory ||
      chatHistoryLoading ||
      remoteHistoryLoadPendingRef.current
    )
      return;
    rememberChatScrollPosition();
    remoteHistoryLoadPendingRef.current = true;
    try {
      await onLoadMoreChatHistory();
    } finally {
      remoteHistoryLoadPendingRef.current = false;
    }
  }, [
    canLoadOlderChatMessages,
    chatHistoryLoading,
    onLoadMoreChatHistory,
    rememberChatScrollPosition,
  ]);
  const handleChatScroll = useCallback(
    (element: HTMLElement) => {
      if (autoChatScrollPendingRef.current) {
        stickyChatScrollRef.current = true;
        setChatAwayFromBottom(false);
        setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
        return;
      }
      const nearBottom = isNearChatBottom(element);
      stickyChatScrollRef.current = nearBottom;
      updateChatScrollControls(element, { nearBottom });
      if (
        !initialChatScrollPendingRef.current &&
        element.scrollTop <= CHAT_HISTORY_TOP_THRESHOLD_PX &&
        canLoadOlderChatMessages &&
        !chatHistoryLoading
      ) {
        void loadOlderChatMessages();
      }
    },
    [
      canLoadOlderChatMessages,
      chatHistoryLoading,
      loadOlderChatMessages,
      setChatAwayFromBottom,
      setUserMessageNavigationState,
      updateChatScrollControls,
    ]
  );
  useLayoutEffect(() => {
    if (view !== "chat" || !showChatThread || typeof window === "undefined")
      return undefined;
    const element = composerStackRef.current;
    if (!element) return undefined;

    let animationFrame: number | null = null;
    const updateReserve = () => {
      animationFrame = null;
      const nextReserve = Math.max(
        96,
        Math.ceil(element.getBoundingClientRect().height + 20)
      );
      setChatComposerReservePx((current) =>
        current === nextReserve ? current : nextReserve
      );
    };
    const scheduleUpdate = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(updateReserve);
    };

    scheduleUpdate();
    const resizeObserver =
      typeof window.ResizeObserver === "undefined"
        ? null
        : new window.ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [showChatThread, view]);
  useLayoutEffect(() => {
    const element = chatThreadRef.current;
    if (
      view !== "chat" ||
      !showChatThread ||
      !element ||
      initialChatScrollPendingRef.current
    )
      return;
    if (!stickyChatScrollRef.current && !isNearChatBottom(element)) return;
    stickyChatScrollRef.current = true;
    scrollChatToBottom(element, { settle: true });
  }, [chatComposerReservePx, scrollChatToBottom, showChatThread, view]);

  useLayoutEffect(() => {
    pendingChatScrollRestoreRef.current = null;
    remoteHistoryLoadPendingRef.current = false;
    initialChatScrollPendingRef.current = true;
    stickyChatScrollRef.current = true;
    cancelSmoothChatScroll();
    cancelScheduledChatBottomScroll();
    setInitialChatScrollReadyKey(null);
    setChatAwayFromBottom(false);
    setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
  }, [
    cancelScheduledChatBottomScroll,
    cancelSmoothChatScroll,
    conversationKey,
    setChatAwayFromBottom,
    setUserMessageNavigationState,
  ]);
  useEffect(() => {
    const element = chatThreadRef.current;
    if (
      view !== "chat" ||
      !element ||
      initialChatScrollPendingRef.current ||
      !canLoadOlderChatMessages ||
      chatHistoryLoading
    ) {
      return;
    }
    if (
      element.scrollTop <= CHAT_HISTORY_TOP_THRESHOLD_PX &&
      element.scrollHeight <=
        element.clientHeight + CHAT_HISTORY_TOP_THRESHOLD_PX
    ) {
      void loadOlderChatMessages();
    }
  }, [
    canLoadOlderChatMessages,
    chatHistoryLoading,
    initialChatScrollVersion,
    chatTimelineRows.length,
    loadOlderChatMessages,
    view,
  ]);
  useLayoutEffect(() => {
    const restore = pendingChatScrollRestoreRef.current;
    const element = chatThreadRef.current;
    if (!restore || !element || initialChatScrollPendingRef.current) return;
    pendingChatScrollRestoreRef.current = null;
    element.scrollTop =
      restore.scrollTop +
      Math.max(0, element.scrollHeight - restore.scrollHeight);
    updateChatScrollControls(element);
  }, [chatTimelineRows.length, updateChatScrollControls]);
  useLayoutEffect(() => {
    const element = chatThreadRef.current;
    if (view !== "chat" || !conversationKey || !element) {
      previousConversationKeyRef.current = conversationKey;
      stickyChatScrollRef.current = true;
      finishInitialChatScroll(conversationKey);
      return;
    }

    const conversationChanged =
      previousConversationKeyRef.current !== conversationKey;
    previousConversationKeyRef.current = conversationKey;

    if (conversationChanged || initialChatScrollPendingRef.current) {
      stickyChatScrollRef.current = true;
      scrollChatToBottom(element, {
        conversationKey,
        finishInitial: true,
        settle: true,
      });
      return;
    }

    const nearBottom = isNearChatBottom(element);
    if (stickyChatScrollRef.current || nearBottom) {
      stickyChatScrollRef.current = true;
      setChatAwayFromBottom(false);
      setUserMessageNavigationState(userMessageNavigationState(element));
      scrollChatToBottom(element, { settle: true });
      return;
    }
    updateChatScrollControls(element, { nearBottom });
  }, [
    chatScrollContentKey,
    conversationKey,
    finishInitialChatScroll,
    pendingApproval?.id,
    scrollChatToBottom,
    setChatAwayFromBottom,
    setUserMessageNavigationState,
    updateChatScrollControls,
    view,
  ]);
  useEffect(
    () => () => {
      cancelScheduledChatBottomScroll();
      cancelSmoothChatScroll();
    },
    [cancelScheduledChatBottomScroll, cancelSmoothChatScroll]
  );

  return {
    chatColumnStyle,
    chatThreadPreparingInitialScroll,
    chatThreadRef,
    composerStackRef,
    goToUserMessage,
    handleChatScroll,
    jumpToLatestChatMessage,
    showScrollToBottomButton,
    userMessageNavigation,
    chatTimelineRows,
  };
}
