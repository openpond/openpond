import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { reserveSentMessageSpace, type SentMessageAnchor } from "./sent-message-scroll";
import { observeChatScrollIntent } from "./chat-scroll-intent";
import {
  captureChatHistoryAnchor,
  restoreChatHistoryAnchor,
  type ChatHistoryScrollAnchor,
} from "./chat-history-scroll-anchor";
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
  userMessageRows,
  type UserMessageNavigationState,
} from "./main-pane-helpers";
import type { MainPaneProps } from "./main-pane-types";
import { useChatContentScrollScheduler } from "../../hooks/useChatContentScrollScheduler";

export function useMainPaneChatScroll({
  browserConversationId,
  chatSubmissionVersion,
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
  chatSubmissionVersion: number;
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
  const [chatThreadElement, setChatThreadElement] =
    useState<HTMLElement | null>(null);
  const attachChatThreadRef = useCallback((element: HTMLElement | null) => {
    chatThreadRef.current = element;
    setChatThreadElement((current) => (current === element ? current : element));
  }, []);
  const composerStackRef = useRef<HTMLDivElement | null>(null);
  const stickyChatScrollRef = useRef(true);
  const sentMessageAnchorRef = useRef<SentMessageAnchor | null>(null);
  const observedSubmissionRef = useRef(0);
  const previousUserRowRef = useRef<HTMLElement | null>(null);
  const lastChatScrollTopRef = useRef(0);
  const lastChatScrollHeightRef = useRef(0);
  const lastChatClientHeightRef = useRef(0);
  const previousConversationKeyRef = useRef<string | null>(null);
  const pendingChatScrollRestoreRef = useRef<{
    anchor: ChatHistoryScrollAnchor | null;
    firstRowId: string | undefined;
    settled: boolean;
  } | null>(null);
  const remoteHistoryLoadPendingRef = useRef<object | null>(null);
  const initialChatScrollPendingRef = useRef(false);
  const autoChatScrollPendingRef = useRef(false);
  const autoChatScrollFrameRef = useRef<number | null>(null);
  const streamFollowFrameRef = useRef<number | null>(null);
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
  const cancelStreamFollow = useCallback(() => {
    if (
      streamFollowFrameRef.current === null ||
      typeof window === "undefined"
    )
      return;
    window.cancelAnimationFrame(streamFollowFrameRef.current);
    streamFollowFrameRef.current = null;
  }, []);
  const followStreamingChatBottom = useCallback((element: HTMLElement) => {
    if (typeof window === "undefined") {
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (streamFollowFrameRef.current !== null) return;

    let previousFrameTime = window.performance.now();
    const follow = (frameTime: number) => {
      if (
        chatThreadRef.current !== element ||
        !stickyChatScrollRef.current
      ) {
        streamFollowFrameRef.current = null;
        return;
      }

      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const distance = target - element.scrollTop;
      if (Math.abs(distance) <= 0.75) {
        element.scrollTop = target;
        streamFollowFrameRef.current = null;
        return;
      }

      if (distance < 0 || distance > 240) {
        element.scrollTop = target;
      } else {
        const elapsedFrames = Math.max(
          0.5,
          Math.min(3, (frameTime - previousFrameTime) / (1000 / 60))
        );
        const easing = 1 - Math.pow(1 - 0.22, elapsedFrames);
        element.scrollTop += Math.min(36 * elapsedFrames, distance * easing);
      }
      previousFrameTime = frameTime;
      streamFollowFrameRef.current = window.requestAnimationFrame(follow);
    };

    streamFollowFrameRef.current = window.requestAnimationFrame(follow);
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
      cancelStreamFollow();
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
      cancelStreamFollow,
      finishInitialChatScroll,
      setChatAwayFromBottom,
      setUserMessageNavigationState,
    ]
  );
  const jumpToLatestChatMessage = useCallback(() => {
    sentMessageAnchorRef.current = null;
    chatThreadRef.current?.style.removeProperty("--chat-sent-message-space");
    const element = chatThreadRef.current;
    if (!element) return;
    cancelScheduledChatBottomScroll();
    cancelStreamFollow();
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
    cancelStreamFollow,
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
      cancelStreamFollow();
      if (sentMessageAnchorRef.current) sentMessageAnchorRef.current.following = false;
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
      cancelStreamFollow,
      smoothScrollChatTo,
      updateChatScrollControls,
    ]
  );
  const loadOlderChatMessages = useCallback(async () => {
    if (!canLoadOlderChatMessages) return;
    if (
      !onLoadMoreChatHistory ||
      chatHistoryLoading ||
      remoteHistoryLoadPendingRef.current
    )
      return;
    const element = chatThreadRef.current;
    if (!element) return;
    const restore = {
      anchor: captureChatHistoryAnchor(element),
      firstRowId: chatTimelineRows[0]?.id,
      settled: false,
    };
    pendingChatScrollRestoreRef.current = restore;
    stickyChatScrollRef.current = false;
    cancelScheduledChatBottomScroll();
    cancelStreamFollow();
    cancelSmoothChatScroll();
    remoteHistoryLoadPendingRef.current = restore;
    try {
      const loaded = await onLoadMoreChatHistory();
      if (!loaded && pendingChatScrollRestoreRef.current === restore) {
        pendingChatScrollRestoreRef.current = null;
      }
    } finally {
      restore.settled = true;
      // A request belonging to a previous conversation must not unlock this one.
      if (remoteHistoryLoadPendingRef.current === restore) {
        remoteHistoryLoadPendingRef.current = null;
      }
    }
  }, [
    canLoadOlderChatMessages,
    chatHistoryLoading,
    onLoadMoreChatHistory,
    chatTimelineRows,
    cancelScheduledChatBottomScroll,
    cancelStreamFollow,
    cancelSmoothChatScroll,
  ]);
  const handleChatScroll = useCallback(
    (element: HTMLElement) => {
      const restore = pendingChatScrollRestoreRef.current;
      if (restore) restore.anchor = captureChatHistoryAnchor(element);
      const nearBottom = isNearChatBottom(element);
      const layoutChanged =
        Math.abs(element.scrollHeight - lastChatScrollHeightRef.current) > 1 ||
        Math.abs(element.clientHeight - lastChatClientHeightRef.current) > 1;
      const movedUp = element.scrollTop < lastChatScrollTopRef.current - 1;
      const movedDown = element.scrollTop > lastChatScrollTopRef.current + 1;
      lastChatScrollTopRef.current = element.scrollTop;
      lastChatScrollHeightRef.current = element.scrollHeight;
      lastChatClientHeightRef.current = element.clientHeight;
      if (sentMessageAnchorRef.current) {
        stickyChatScrollRef.current = false;
        updateChatScrollControls(element);
      } else if (autoChatScrollPendingRef.current) {
        stickyChatScrollRef.current = true;
        setChatAwayFromBottom(false);
        setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
        return;
      } else if (
        nearBottom &&
        (stickyChatScrollRef.current || (movedDown && !layoutChanged))
      ) {
        stickyChatScrollRef.current = true;
        updateChatScrollControls(element, { nearBottom: true });
      } else if (movedUp && !layoutChanged) {
        stickyChatScrollRef.current = false;
        cancelStreamFollow();
        updateChatScrollControls(element, { nearBottom: false });
      } else if (stickyChatScrollRef.current) {
        setChatAwayFromBottom(false);
        setUserMessageNavigationState(userMessageNavigationState(element));
      } else {
        updateChatScrollControls(element, { nearBottom });
      }
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
      cancelStreamFollow,
      chatHistoryLoading,
      loadOlderChatMessages,
      setChatAwayFromBottom,
      setUserMessageNavigationState,
      updateChatScrollControls,
    ]
  );
  const handleChatContentMutation = useCallback(
    (element: HTMLElement) => {
      const anchor = sentMessageAnchorRef.current;
      if (anchor) {
        const target = reserveSentMessageSpace(element, anchor);
        if (target !== null && anchor.following && smoothChatScrollFrameRef.current === null) element.scrollTop = target;
        updateChatScrollControls(element);
        return;
      }
      if (
        !stickyChatScrollRef.current ||
        smoothChatScrollFrameRef.current !== null ||
        autoChatScrollPendingRef.current
      ) return;
      followStreamingChatBottom(element);
    },
    [followStreamingChatBottom, updateChatScrollControls]
  );
  useEffect(() => {
    const element = chatThreadElement;
    if (!element) return;
    // Read user intent before the scroll event: streaming layout changes and
    // our settling frames can otherwise hide an upward movement or undo it.
    const stopFollowing = () => {
      if (sentMessageAnchorRef.current) sentMessageAnchorRef.current.following = false;
      stickyChatScrollRef.current = false;
      lastChatScrollTopRef.current = element.scrollTop;
      lastChatScrollHeightRef.current = element.scrollHeight;
      lastChatClientHeightRef.current = element.clientHeight;
      cancelScheduledChatBottomScroll();
      cancelStreamFollow();
      cancelSmoothChatScroll();
    };
    const stopSentMessageFollowing = () => {
      if (sentMessageAnchorRef.current) stopFollowing();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stopSentMessageFollowing();
    };
    const dispose = observeChatScrollIntent(element, stopFollowing);
    element.addEventListener("wheel", stopSentMessageFollowing, { passive: true });
    element.addEventListener("touchmove", stopSentMessageFollowing, { passive: true });
    element.addEventListener("pointerdown", stopSentMessageFollowing);
    element.addEventListener("keydown", onKeyDown);
    return () => {
      dispose();
      element.removeEventListener("wheel", stopSentMessageFollowing);
      element.removeEventListener("touchmove", stopSentMessageFollowing);
      element.removeEventListener("pointerdown", stopSentMessageFollowing);
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [chatThreadElement, cancelScheduledChatBottomScroll, cancelStreamFollow, cancelSmoothChatScroll]);
  useEffect(() => {
    if (!chatThreadElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (sentMessageAnchorRef.current) handleChatContentMutation(chatThreadElement);
    });
    observer.observe(chatThreadElement);
    return () => observer.disconnect();
  }, [chatThreadElement, handleChatContentMutation]);
  useChatContentScrollScheduler({
    contentKey: chatScrollContentKey,
    enabled: view === "chat" && showChatThread,
    onContentChange: handleChatContentMutation,
    threadElement: chatThreadElement,
    threadRef: chatThreadRef,
  });
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
    if (sentMessageAnchorRef.current) {
      handleChatContentMutation(element);
      return;
    }
    if (!stickyChatScrollRef.current) return;
    scrollChatToBottom(element, { settle: true });
  }, [chatComposerReservePx, handleChatContentMutation, scrollChatToBottom, showChatThread, view]);

  useLayoutEffect(() => {
    sentMessageAnchorRef.current = null;
    chatThreadRef.current?.style.removeProperty("--chat-sent-message-space");
    pendingChatScrollRestoreRef.current = null;
    remoteHistoryLoadPendingRef.current = null;
    initialChatScrollPendingRef.current = true;
    stickyChatScrollRef.current = true;
    lastChatScrollTopRef.current = 0;
    lastChatScrollHeightRef.current = 0;
    lastChatClientHeightRef.current = 0;
    cancelStreamFollow();
    cancelSmoothChatScroll();
    cancelScheduledChatBottomScroll();
    setInitialChatScrollReadyKey(null);
    setChatAwayFromBottom(false);
    setUserMessageNavigationState(EMPTY_USER_MESSAGE_NAVIGATION);
  }, [
    cancelScheduledChatBottomScroll,
    cancelSmoothChatScroll,
    cancelStreamFollow,
    conversationKey,
    setChatAwayFromBottom,
    setUserMessageNavigationState,
  ]);
  useLayoutEffect(() => {
    if (chatSubmissionVersion === 0 || chatSubmissionVersion === observedSubmissionRef.current || view !== "chat" || !showChatThread) return;
    const element = chatThreadRef.current;
    const row = element ? userMessageRows(element).at(-1) : undefined;
    if (!element || !row || row === previousUserRowRef.current) return;
    observedSubmissionRef.current = chatSubmissionVersion;
    cancelScheduledChatBottomScroll();
    cancelStreamFollow();
    const anchor: SentMessageAnchor = { row, following: true };
    sentMessageAnchorRef.current = anchor;
    stickyChatScrollRef.current = false;
    reserveSentMessageSpace(element, anchor);
    smoothScrollChatTo(element, () => reserveSentMessageSpace(element, anchor) ?? element.scrollTop);
    finishInitialChatScroll(conversationKey);
  }, [chatSubmissionVersion, chatTimelineRows, chatThreadElement, conversationKey, view, showChatThread, cancelScheduledChatBottomScroll, cancelStreamFollow, smoothScrollChatTo, finishInitialChatScroll]);

  useLayoutEffect(() => {
    const element = chatThreadRef.current;
    previousUserRowRef.current = element ? userMessageRows(element).at(-1) ?? null : null;
  });

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
    // Appends/stream updates can arrive while the older page is in flight.
    // Only consume the anchor once rows actually appear before the old first row.
    if (chatTimelineRows[0]?.id === restore.firstRowId) {
      if (restore.settled && !chatHistoryLoading) {
        pendingChatScrollRestoreRef.current = null;
      }
      return;
    }
    pendingChatScrollRestoreRef.current = null;
    if (restore.anchor) restoreChatHistoryAnchor(element, restore.anchor);
    updateChatScrollControls(element);
  }, [chatTimelineRows, chatHistoryLoading, updateChatScrollControls]);
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

    if (sentMessageAnchorRef.current) {
      finishInitialChatScroll(conversationKey);
      return;
    }
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
    if (stickyChatScrollRef.current) {
      stickyChatScrollRef.current = true;
      setChatAwayFromBottom(false);
      setUserMessageNavigationState(userMessageNavigationState(element));
      scrollChatToBottom(element, { settle: true });
      return;
    }
    updateChatScrollControls(element, { nearBottom });
  }, [
    conversationKey,
    chatThreadElement,
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
      cancelStreamFollow();
    },
    [
      cancelScheduledChatBottomScroll,
      cancelSmoothChatScroll,
      cancelStreamFollow,
    ]
  );

  return {
    chatColumnStyle,
    chatThreadPreparingInitialScroll,
    chatThreadRef: attachChatThreadRef,
    composerStackRef,
    goToUserMessage,
    handleChatScroll,
    jumpToLatestChatMessage,
    showScrollToBottomButton,
    userMessageNavigation,
    chatTimelineRows,
  };
}
