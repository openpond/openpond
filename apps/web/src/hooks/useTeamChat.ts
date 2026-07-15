import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatAttachment,
  TeamChatAttachment,
  TeamChatEvent,
  TeamChatMessage,
} from "@openpond/contracts";
import type { TeamChatRealtimeSession } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { openTeamChatRealtime } from "../api/team-chat-realtime";
import {
  applyCanonicalMessage,
  applyOptimisticMessage,
  applySelectedTeamChatAiThread,
  applyTeamChatEvent,
  clearCanonicalPendingMessages,
  createOptimisticMessage,
  markOptimisticMessageFailed,
  mergePendingThreadDetail,
  mergePendingThreadList,
  mergeThreadDetail,
  messageFromEvent,
  removeOptimisticMessage,
  teamChatImageInputs,
  uniqueMessages,
  updateOptimisticDeliveryStatus,
  updateOptimisticUploadProgress,
  updatePendingMessageDelivery,
  updatePendingMessageUploadProgress,
  type PendingAttachmentState,
  type TeamChatState,
} from "./team-chat-state";
import { teamChatErrorMessage } from "../lib/team-chat-error";
import {
  readTeamChatNotificationMode,
  shouldNotifyForTeamChatMessage,
  teamChatIncomingNotification,
  writeTeamChatNotificationMode,
  type TeamChatIncomingNotification,
  type TeamChatNotificationMode,
} from "../lib/team-chat-notifications";

const INITIAL_STATE: TeamChatState = {
  members: [],
  agents: [],
  threads: [],
  selectedThreadId: null,
  detail: null,
  aiThread: null,
  agentConversation: null,
  loading: false,
  busy: false,
  error: null,
};

export function clearTeamChatThreadUnreadCount(
  threads: TeamChatState["threads"],
  threadId: string,
): TeamChatState["threads"] {
  return threads.map((thread) =>
    thread.id === threadId && thread.unreadCount !== 0
      ? { ...thread, unreadCount: 0 }
      : thread,
  );
}

export function clearTeamChatDetailUnreadCount(
  detail: TeamChatState["detail"],
): TeamChatState["detail"] {
  if (!detail || detail.thread.unreadCount === 0) return detail;
  return {
    ...detail,
    thread: { ...detail.thread, unreadCount: 0 },
  };
}

export function buildTeamChatAgentContinuationInput(input: {
  teamId: string;
  body: string;
  clientRequestId: string;
  conversation: NonNullable<TeamChatState["agentConversation"]>;
}) {
  return {
    teamId: input.teamId,
    body: input.body.trim(),
    clientRequestId: input.clientRequestId,
    selectedAgentId: input.conversation.agent.id,
    conversationId: input.conversation.conversationId,
  };
}

export function buildTeamChatSelectedActionRunInput(input: {
  teamId: string;
  body: string;
  clientRequestId: string;
  selectedActionKey: string;
  approvalId?: string | null;
}) {
  return {
    teamId: input.teamId,
    body: input.body.trim(),
    clientRequestId: input.clientRequestId,
    selectedActionKey: input.selectedActionKey,
    approvalId: input.approvalId ?? null,
  };
}

export async function markOpenedTeamChatThreadRead(
  input: {
    connection: ClientConnection;
    teamId: string;
    threadId: string;
    lastMessageSequence: number;
  },
  markRead: typeof api.markTeamChatRead = api.markTeamChatRead,
): Promise<boolean> {
  if (input.lastMessageSequence <= 0) return false;
  return markRead(
    input.connection,
    input.threadId,
    input.teamId,
    input.lastMessageSequence,
  ).then(
    () => true,
    () => false,
  );
}

export function useTeamChat(input: {
  connection: ClientConnection | null;
  teamId: string | null;
  currentUserId: string | null;
  refreshToken?: string | null;
}) {
  const [state, setState] = useState<TeamChatState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [notificationMode, setNotificationModeState] =
    useState<TeamChatNotificationMode>(readTeamChatNotificationMode);
  const [incomingNotification, setIncomingNotification] =
    useState<TeamChatIncomingNotification | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const aiConversationIdRef = useRef<string | null>(null);
  const aiSelectionVersionRef = useRef(0);
  const aiRefreshVersionsRef = useRef(new Map<string, number>());
  const threadRefreshVersionsRef = useRef(new Map<string, number>());
  const threadSelectionVersionRef = useRef(0);
  const agentRunIdRef = useRef<string | null>(null);
  const eventCursorRef = useRef(0);
  const seenEventIdsRef = useRef(new Set<number>());
  const latestNotifiedEventIdRef = useRef(0);
  const catchupRunningRef = useRef(false);
  const pendingMessagesRef = useRef(new Map<string, TeamChatMessage>());
  const pendingAttachmentsRef = useRef(new Map<string, PendingAttachmentState>());
  const [realtimeSession, setRealtimeSession] = useState<TeamChatRealtimeSession | null>(null);
  const [realtimeBootstrapTeamId, setRealtimeBootstrapTeamId] = useState<string | null>(null);

  const setNotificationMode = useCallback((mode: TeamChatNotificationMode) => {
    setNotificationModeState(mode);
    writeTeamChatNotificationMode(mode);
  }, []);

  const dismissIncomingNotification = useCallback((eventId: number) => {
    setIncomingNotification((current) =>
      current?.eventId === eventId ? null : current,
    );
  }, []);

  const refreshThreads = useCallback(async () => {
    if (!input.connection || !input.teamId) return [];
    const payload = await api.teamChatThreads(input.connection, input.teamId);
    const threads = mergePendingThreadList(payload.threads, pendingMessagesRef.current);
    setState((current) => ({ ...current, threads }));
    return threads;
  }, [input.connection, input.teamId]);

  const refreshDirectory = useCallback(async () => {
    if (!input.connection || !input.teamId) {
      return { members: [], agents: [] };
    }
    const [members, agents] = await Promise.all([
      api.teamChatMembers(input.connection, input.teamId),
      api.teamChatAgents(input.connection, input.teamId),
    ]);
    setState((current) => ({
      ...current,
      members: members.members,
      agents: agents.agents,
    }));
    return { members: members.members, agents: agents.agents };
  }, [input.connection, input.teamId]);

  const refreshThread = useCallback(
    async (threadId?: string | null) => {
      const id = threadId ?? selectedThreadIdRef.current;
      if (!input.connection || !input.teamId || !id) return null;
      const refreshVersion = (threadRefreshVersionsRef.current.get(id) ?? 0) + 1;
      threadRefreshVersionsRef.current.set(id, refreshVersion);
      const hostedDetail = await api.teamChatThread(input.connection, input.teamId, id);
      clearCanonicalPendingMessages(
        hostedDetail.messages,
        pendingMessagesRef.current,
        pendingAttachmentsRef.current,
      );
      const detail = mergePendingThreadDetail(hostedDetail, pendingMessagesRef.current);
      if (threadRefreshVersionsRef.current.get(id) !== refreshVersion) return detail;
      setState((current) =>
        current.selectedThreadId === id
          ? {
              ...current,
              threads: clearTeamChatThreadUnreadCount(current.threads, id),
              detail: clearTeamChatDetailUnreadCount(mergeThreadDetail(current.detail, detail)),
            }
          : current,
      );
      if (
        selectedThreadIdRef.current === id &&
        detail.thread.lastMessageSequence > 0
      ) {
        await api
          .markTeamChatRead(input.connection, id, input.teamId, detail.thread.lastMessageSequence)
          .catch(() => undefined);
      }
      return detail;
    },
    [input.connection, input.teamId],
  );

  const refreshAiThread = useCallback(
    async (conversationId?: string | null) => {
      const id = conversationId ?? aiConversationIdRef.current;
      if (!input.connection || !input.teamId || !id) return null;
      const refreshVersion = (aiRefreshVersionsRef.current.get(id) ?? 0) + 1;
      aiRefreshVersionsRef.current.set(id, refreshVersion);
      const thread = await api.teamChatAiThread(input.connection, input.teamId, id);
      if (
        aiRefreshVersionsRef.current.get(id) === refreshVersion &&
        aiConversationIdRef.current === id
      ) {
        setState((current) =>
          applySelectedTeamChatAiThread(
            current,
            thread,
            aiConversationIdRef.current,
          ),
        );
      }
      return thread;
    },
    [input.connection, input.teamId],
  );

  const refreshAgentConversation = useCallback(
    async (agentRunId?: string | null) => {
      const id = agentRunId ?? agentRunIdRef.current;
      if (!input.connection || !input.teamId || !id) return null;
      const agentConversation = await api.teamChatAgentConversation(
        input.connection,
        input.teamId,
        id,
      );
      setState((current) =>
        current.agentConversation?.run.id === id
          ? { ...current, agentConversation }
          : current,
      );
      return agentConversation;
    },
    [input.connection, input.teamId],
  );

  useEffect(() => {
    selectedThreadIdRef.current = state.selectedThreadId;
  }, [state.selectedThreadId]);

  useEffect(() => {
    agentRunIdRef.current = state.agentConversation?.run.id ?? null;
  }, [state.agentConversation?.run.id]);

  useEffect(() => {
    const status = state.agentConversation?.run.status;
    if (!status || !["pending", "queued", "running"].includes(status)) return;
    const timer = window.setInterval(() => {
      void refreshAgentConversation().catch((error) => {
        setState((current) => ({ ...current, error: errorMessage(error) }));
      });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [refreshAgentConversation, state.agentConversation?.run.status]);

  useEffect(() => {
    if (!input.connection || !input.teamId || !input.currentUserId) {
      setState(INITIAL_STATE);
      setRealtimeSession(null);
      setRealtimeBootstrapTeamId(null);
      pendingAttachmentsRef.current.clear();
      pendingMessagesRef.current.clear();
      threadRefreshVersionsRef.current.clear();
      aiRefreshVersionsRef.current.clear();
      threadSelectionVersionRef.current += 1;
      setIncomingNotification(null);
      seenEventIdsRef.current.clear();
      latestNotifiedEventIdRef.current = 0;
      eventCursorRef.current = 0;
      return;
    }
    let cancelled = false;
    aiConversationIdRef.current = null;
    aiSelectionVersionRef.current += 1;
    threadSelectionVersionRef.current += 1;
    setRealtimeSession(null);
    setRealtimeBootstrapTeamId(null);
    pendingAttachmentsRef.current.clear();
    pendingMessagesRef.current.clear();
    seenEventIdsRef.current.clear();
    latestNotifiedEventIdRef.current = 0;
    setState((current) => ({
      ...current,
      aiThread: null,
      agentConversation: null,
      loading: true,
      error: null,
    }));
    void (async () => {
      try {
        const baseline = await api.teamChatEvents(input.connection!, input.teamId!);
        if (cancelled) return;
        eventCursorRef.current = baseline.cursor;
        const membersPromise = api.teamChatMembers(input.connection!, input.teamId!);
        const agentsPromise = api.teamChatAgents(input.connection!, input.teamId!);
        const general = await api.teamChatGeneral(input.connection!, input.teamId!);
        const [members, agents, threads] = await Promise.all([
          membersPromise,
          agentsPromise,
          api.teamChatThreads(input.connection!, input.teamId!),
        ]);
        if (cancelled) return;
        const selectedThreadId =
          selectedThreadIdRef.current &&
          threads.threads.some((thread) => thread.id === selectedThreadIdRef.current)
            ? selectedThreadIdRef.current
            : general.thread.id;
        const detail =
          selectedThreadId === general.thread.id
            ? general
            : await api.teamChatThread(input.connection!, input.teamId!, selectedThreadId);
        if (cancelled) return;
        const readDetail = clearTeamChatDetailUnreadCount(detail);
        setState((current) => ({
          ...current,
          members: members.members,
          agents: agents.agents,
          threads: clearTeamChatThreadUnreadCount(threads.threads, selectedThreadId),
          selectedThreadId,
          detail: readDetail,
          loading: false,
          error: null,
        }));
        void markOpenedTeamChatThreadRead({
          connection: input.connection!,
          teamId: input.teamId!,
          threadId: selectedThreadId,
          lastMessageSequence: readDetail?.thread.lastMessageSequence ?? 0,
        });
        setRealtimeBootstrapTeamId(input.teamId!);
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: errorMessage(error),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [input.connection, input.currentUserId, input.refreshToken, input.teamId]);

  const applyRealtimeEvent = useCallback(
    (event: TeamChatEvent) => {
      if (seenEventIdsRef.current.has(event.id)) return;
      seenEventIdsRef.current.add(event.id);
      if (seenEventIdsRef.current.size > 2000) {
        const oldest = seenEventIdsRef.current.values().next().value;
        if (typeof oldest === "number") seenEventIdsRef.current.delete(oldest);
      }
      const message = messageFromEvent(event);
      if (message && event.type === "message.created") {
        const snapshot = stateRef.current;
        const thread = snapshot.threads.find(
          (candidate) => candidate.id === message.threadId,
        ) ?? (snapshot.detail?.thread.id === message.threadId
          ? snapshot.detail.thread
          : null);
        const notify = (sourceThread: NonNullable<typeof thread>) => {
          if (event.id <= latestNotifiedEventIdRef.current) return;
          if (!shouldNotifyForTeamChatMessage({
            mode: notificationMode,
            currentUserId: input.currentUserId,
            message,
            thread: sourceThread,
          })) return;
          latestNotifiedEventIdRef.current = event.id;
          setIncomingNotification(teamChatIncomingNotification({
            eventId: event.id,
            message,
            thread: sourceThread,
            members: snapshot.members,
          }));
        };
        if (thread) {
          notify(thread);
        } else {
          // A DM's first message can arrive immediately after thread.created,
          // before the asynchronous directory refresh has added the thread.
          void refreshThreads()
            .then((threads) => {
              const createdThread = threads.find(
                (candidate) => candidate.id === message.threadId,
              );
              if (createdThread) notify(createdThread);
            })
            .catch(() => undefined);
        }
      }
      if (message?.clientRequestId && !message.id.startsWith("pending:")) {
        pendingMessagesRef.current.delete(message.clientRequestId);
        pendingAttachmentsRef.current.delete(message.clientRequestId);
      }
      setState((current) => applyTeamChatEvent(current, event, input.currentUserId));
      if (event.type === "thread.created") {
        void refreshThreads().catch((error) => {
          setState((current) => ({ ...current, error: errorMessage(error) }));
        });
      }
      if (event.type === "ai_thread.created" || event.type === "ai_turn.updated") {
        void refreshThread(event.threadId).catch((error) => {
          setState((current) => ({ ...current, error: errorMessage(error) }));
        });
        if (event.conversationId === aiConversationIdRef.current) {
          void refreshAiThread(event.conversationId).catch((error) => {
            setState((current) => ({ ...current, error: errorMessage(error) }));
          });
        }
      }
      if (
        message &&
        event.type === "message.created" &&
        selectedThreadIdRef.current === message.threadId &&
        message.authorUserId !== input.currentUserId &&
        input.connection &&
        input.teamId
      ) {
        void api
          .markTeamChatRead(input.connection, message.threadId, input.teamId, message.sequence)
          .catch(() => undefined);
      }
    },
    [
      input.connection,
      input.currentUserId,
      input.teamId,
      notificationMode,
      refreshAiThread,
      refreshThread,
      refreshThreads,
    ],
  );

  const catchUpEvents = useCallback(async () => {
    if (!input.connection || !input.teamId || catchupRunningRef.current) return;
    catchupRunningRef.current = true;
    try {
      let hasMore = true;
      while (hasMore) {
        const page = await api.teamChatEvents(input.connection, input.teamId, {
          after: eventCursorRef.current,
          limit: 250,
        });
        for (const event of page.events) applyRealtimeEvent(event);
        eventCursorRef.current = page.cursor;
        hasMore = page.hasMore;
      }
    } finally {
      catchupRunningRef.current = false;
    }
  }, [applyRealtimeEvent, input.connection, input.teamId]);

  useEffect(() => {
    if (!input.connection || !input.teamId || realtimeBootstrapTeamId !== input.teamId) {
      return;
    }
    let cancelled = false;
    let renewalTimer: number | null = null;
    const loadSession = async () => {
      try {
        const session = await api.teamChatRealtimeSession(input.connection!, input.teamId!);
        if (cancelled) return;
        await catchUpEvents();
        if (cancelled) return;
        setRealtimeSession(session);
        const renewIn = Math.max(
          30_000,
          new Date(session.expiresAt).getTime() - Date.now() - 30_000,
        );
        renewalTimer = window.setTimeout(() => void loadSession(), renewIn);
      } catch {
        if (!cancelled) {
          void catchUpEvents().catch(() => undefined);
          renewalTimer = window.setTimeout(() => void loadSession(), 10_000);
        }
      }
    };
    void loadSession();
    return () => {
      cancelled = true;
      if (renewalTimer !== null) window.clearTimeout(renewalTimer);
      setRealtimeSession(null);
    };
  }, [catchUpEvents, input.connection, input.teamId, realtimeBootstrapTeamId]);

  const subscribedThreadIds = state.threads
    .map((thread) => thread.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!realtimeSession) return;
    const realtime = openTeamChatRealtime({
      session: realtimeSession,
      threadIds: subscribedThreadIds ? subscribedThreadIds.split(",") : [],
      onEvent: applyRealtimeEvent,
      onReady: () => {
        void catchUpEvents().catch((error) => {
          setState((current) => ({ ...current, error: errorMessage(error) }));
        });
      },
      onError: () => {
        void catchUpEvents().catch(() => undefined);
      },
    });
    return () => {
      realtime.close();
    };
  }, [applyRealtimeEvent, catchUpEvents, realtimeSession, subscribedThreadIds]);

  useEffect(() => {
    if (!input.connection || !input.teamId || realtimeBootstrapTeamId !== input.teamId) {
      return;
    }
    const catchupTimer = window.setInterval(() => {
      void catchUpEvents().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(catchupTimer);
  }, [catchUpEvents, input.connection, input.teamId, realtimeBootstrapTeamId]);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (!input.connection || !input.teamId) return;
      const selectionVersion = threadSelectionVersionRef.current + 1;
      threadSelectionVersionRef.current = selectionVersion;
      const threadChanged = selectedThreadIdRef.current !== threadId;
      selectedThreadIdRef.current = threadId;
      if (threadChanged) {
        aiSelectionVersionRef.current += 1;
        aiConversationIdRef.current = null;
      }
      setState((current) => ({
        ...current,
        threads: clearTeamChatThreadUnreadCount(current.threads, threadId),
        selectedThreadId: threadId,
        detail:
          current.detail?.thread.id === threadId
            ? clearTeamChatDetailUnreadCount(current.detail)
            : null,
        aiThread: threadChanged ? null : current.aiThread,
        agentConversation: threadChanged ? null : current.agentConversation,
        loading: true,
        error: null,
      }));
      try {
        const hostedDetail = await api.teamChatThread(input.connection, input.teamId, threadId);
        if (
          threadSelectionVersionRef.current !== selectionVersion ||
          selectedThreadIdRef.current !== threadId
        ) {
          return;
        }
        clearCanonicalPendingMessages(
          hostedDetail.messages,
          pendingMessagesRef.current,
          pendingAttachmentsRef.current,
        );
        const detail = mergePendingThreadDetail(hostedDetail, pendingMessagesRef.current);
        setState((current) => ({
          ...current,
          threads: clearTeamChatThreadUnreadCount(current.threads, threadId),
          detail: clearTeamChatDetailUnreadCount(detail),
          loading: false,
        }));
        await api
          .markTeamChatRead(
            input.connection,
            threadId,
            input.teamId,
            detail.thread.lastMessageSequence,
          )
          .catch(() => undefined);
      } catch (error) {
        if (threadSelectionVersionRef.current !== selectionVersion) return;
        setState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
      }
    },
    [input.connection, input.teamId],
  );

  const openDm = useCallback(
    async (otherUserId: string) => {
      if (!input.connection || !input.teamId) return null;
      const selectionVersion = threadSelectionVersionRef.current + 1;
      threadSelectionVersionRef.current = selectionVersion;
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const hostedDetail = await api.teamChatDm(input.connection, input.teamId, otherUserId);
        if (threadSelectionVersionRef.current !== selectionVersion) return null;
        clearCanonicalPendingMessages(
          hostedDetail.messages,
          pendingMessagesRef.current,
          pendingAttachmentsRef.current,
        );
        const detail = mergePendingThreadDetail(hostedDetail, pendingMessagesRef.current);
        const threadChanged = selectedThreadIdRef.current !== detail.thread.id;
        selectedThreadIdRef.current = detail.thread.id;
        if (threadChanged) {
          aiSelectionVersionRef.current += 1;
          aiConversationIdRef.current = null;
        }
        setState((current) => ({
          ...current,
          selectedThreadId: detail.thread.id,
          detail,
          aiThread: threadChanged ? null : current.aiThread,
          agentConversation: threadChanged ? null : current.agentConversation,
          busy: false,
        }));
        await markOpenedTeamChatThreadRead({
          connection: input.connection,
          teamId: input.teamId,
          threadId: detail.thread.id,
          lastMessageSequence: detail.thread.lastMessageSequence,
        });
        await refreshThreads();
        return detail;
      } catch (error) {
        if (threadSelectionVersionRef.current !== selectionVersion) return null;
        setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
        return null;
      }
    },
    [input.connection, input.teamId, refreshThreads],
  );

  const loadMoreMessages = useCallback(async (): Promise<boolean> => {
    const detail = state.detail;
    const firstSequence = detail?.messages[0]?.sequence;
    if (
      !input.connection ||
      !input.teamId ||
      !detail ||
      !detail.hasMoreBefore ||
      firstSequence == null
    ) {
      return false;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const older = await api.teamChatThread(input.connection, input.teamId, detail.thread.id, {
        beforeSequence: firstSequence,
        limit: 50,
      });
      setState((current) => {
        if (current.detail?.thread.id !== detail.thread.id) return current;
        const messages = [...older.messages, ...current.detail.messages];
        return {
          ...current,
          loading: false,
          detail: {
            ...current.detail,
            messages: uniqueMessages(messages),
            hasMoreBefore: older.hasMoreBefore,
          },
        };
      });
      return true;
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
      return false;
    }
  }, [input.connection, input.teamId, state.detail]);

  const sendMessage = useCallback(
    async (params: {
      body: string;
      useModel: boolean;
      providerId: string;
      modelId: string;
      mentionUserIds?: string[];
      attachments?: ChatAttachment[];
      replyToMessage?: TeamChatMessage | null;
      selectedActionKey?: string | null;
      approvalId?: string | null;
    }): Promise<boolean> => {
      const threadId = selectedThreadIdRef.current;
      const attachments = teamChatImageInputs(params.attachments ?? []);
      if (!attachments) {
        setState((current) => ({
          ...current,
          error: "Team chat supports up to 10 PNG, JPEG, WebP, or GIF images per message.",
        }));
        return false;
      }
      if (
        !input.connection ||
        !input.teamId ||
        !threadId ||
        (!params.body.trim() && attachments.length === 0)
      ) {
        return false;
      }
      if (
        params.replyToMessage &&
        (params.replyToMessage.threadId !== threadId ||
          params.replyToMessage.teamId !== input.teamId ||
          params.replyToMessage.id.startsWith("pending:") ||
          Boolean(params.replyToMessage.deletedAt))
      ) {
        setState((current) => ({
          ...current,
          error: "That message is no longer available to reply to.",
        }));
        return false;
      }
      if (params.useModel) {
        if (attachments.length > 0) {
          setState((current) => ({
            ...current,
            error: "Images can be sent to the team thread with Use model turned off.",
          }));
          return false;
        }
        const selectionVersion = aiSelectionVersionRef.current;
        setState((current) => ({ ...current, busy: true, error: null }));
        try {
          const aiThread = await api.createTeamChatAiThread(input.connection, threadId, {
            teamId: input.teamId,
            body: params.body.trim(),
            clientRequestId: crypto.randomUUID(),
            providerId: params.providerId,
            modelId: params.modelId,
          });
          const selectCreatedConversation =
            aiSelectionVersionRef.current === selectionVersion &&
            selectedThreadIdRef.current === threadId;
          if (selectCreatedConversation) {
            aiSelectionVersionRef.current += 1;
            aiConversationIdRef.current = aiThread.conversationId;
          }
          setState((current) => ({
            ...current,
            aiThread: selectCreatedConversation ? aiThread : current.aiThread,
          }));
          if (aiThread.activeTurn) {
            await api.executeTeamChatAiTurn(input.connection, aiThread.activeTurn.id, input.teamId);
          }
          await Promise.all([refreshThread(threadId), refreshThreads()]);
          setState((current) => ({ ...current, busy: false }));
          return true;
        } catch (error) {
          setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
          return false;
        }
      }

      const clientRequestId = crypto.randomUUID();
      if (params.selectedActionKey) {
        if (attachments.length > 0) {
          setState((current) => ({
            ...current,
            error: "Agent invocations do not support image attachments yet.",
          }));
          return false;
        }
        setState((current) => ({ ...current, busy: true, error: null }));
        try {
          await api.createTeamChatAgentRun(
            input.connection,
            threadId,
            buildTeamChatSelectedActionRunInput({
              teamId: input.teamId,
              body: params.body,
              clientRequestId,
              selectedActionKey: params.selectedActionKey,
              approvalId: params.approvalId,
            }),
          );
          await Promise.all([refreshThread(threadId), refreshThreads()]);
          setState((current) => ({ ...current, busy: false }));
          return true;
        } catch (error) {
          setState((current) => ({
            ...current,
            busy: false,
            error: errorMessage(error),
          }));
          return false;
        }
      }
      pendingAttachmentsRef.current.set(clientRequestId, {
        inputs: attachments,
        uploaded: null,
      });
      const optimistic = createOptimisticMessage({
        clientRequestId,
        threadId,
        teamId: input.teamId,
        userId: input.currentUserId,
        body: params.body.trim(),
        mentionUserIds: params.mentionUserIds ?? [],
        attachments,
        replyToMessage: params.replyToMessage,
        sequence: (state.detail?.thread.lastMessageSequence ?? 0) + 1,
      });
      pendingMessagesRef.current.set(clientRequestId, optimistic);
      setState((current) => applyOptimisticMessage(current, optimistic));
      try {
        const uploaded: TeamChatAttachment[] = [];
        for (const [index, attachment] of attachments.entries()) {
          uploaded.push(
            await api.uploadTeamChatAttachment(input.connection, threadId, {
              teamId: input.teamId,
              attachment,
            }),
          );
          updatePendingMessageUploadProgress(
            pendingMessagesRef.current,
            clientRequestId,
            `${index + 1} of ${attachments.length}`,
          );
          setState((current) =>
            updateOptimisticUploadProgress(
              current,
              clientRequestId,
              `${index + 1} of ${attachments.length}`,
            ),
          );
        }
        const pending = pendingAttachmentsRef.current.get(clientRequestId);
        if (pending) pending.uploaded = uploaded;
        const message = await api.sendTeamChatMessage(input.connection, threadId, {
          teamId: input.teamId,
          body: params.body.trim(),
          clientRequestId,
          mentionUserIds: params.mentionUserIds,
          attachmentIds: uploaded.map((attachment) => attachment.id),
          replyToMessageId: params.replyToMessage?.id ?? null,
        });
        pendingAttachmentsRef.current.delete(clientRequestId);
        pendingMessagesRef.current.delete(clientRequestId);
        setState((current) => applyCanonicalMessage(current, message, input.currentUserId));
        return true;
      } catch (error) {
        updatePendingMessageDelivery(pendingMessagesRef.current, clientRequestId, "failed");
        setState((current) => ({
          ...markOptimisticMessageFailed(current, clientRequestId),
          error: errorMessage(error),
        }));
        return false;
      }
    },
    [
      input.connection,
      input.currentUserId,
      input.teamId,
      refreshThread,
      refreshThreads,
      state.detail?.thread.lastMessageSequence,
    ],
  );

  const openAiThread = useCallback(
    async (conversationId: string) => {
      if (!input.connection || !input.teamId) return;
      aiSelectionVersionRef.current += 1;
      aiConversationIdRef.current = conversationId;
      setState((current) => ({
        ...current,
        aiThread:
          current.aiThread?.conversationId === conversationId
            ? current.aiThread
            : null,
        busy: true,
        error: null,
      }));
      try {
        const aiThread = await api.teamChatAiThread(input.connection, input.teamId, conversationId);
        if (aiConversationIdRef.current !== conversationId) return;
        setState((current) => ({ ...current, aiThread, busy: false }));
      } catch (error) {
        if (aiConversationIdRef.current !== conversationId) return;
        setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
      }
    },
    [input.connection, input.teamId],
  );

  const openAgentConversation = useCallback(
    async (agentRunId: string) => {
      if (!input.connection || !input.teamId) return;
      agentRunIdRef.current = agentRunId;
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const agentConversation = await api.teamChatAgentConversation(
          input.connection,
          input.teamId,
          agentRunId,
        );
        setState((current) => ({
          ...current,
          agentConversation,
          busy: false,
        }));
      } catch (error) {
        setState((current) => ({
          ...current,
          busy: false,
          error: errorMessage(error),
        }));
      }
    },
    [input.connection, input.teamId],
  );

  const closeAgentConversation = useCallback(() => {
    agentRunIdRef.current = null;
    setState((current) => ({ ...current, agentConversation: null }));
  }, []);

  const sendAgentTurn = useCallback(
    async (params: {
      body: string;
      clientRequestId: string;
    }): Promise<boolean> => {
      const threadId = selectedThreadIdRef.current;
      const conversation = state.agentConversation;
      if (
        !input.connection ||
        !input.teamId ||
        !threadId ||
        !conversation ||
        !params.body.trim()
      ) {
        return false;
      }
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const result = await api.createTeamChatAgentRun(
          input.connection,
          threadId,
          buildTeamChatAgentContinuationInput({
            teamId: input.teamId,
            body: params.body,
            clientRequestId: params.clientRequestId,
            conversation,
          }),
        );
        agentRunIdRef.current = result.run.id;
        const [agentConversation] = await Promise.all([
          api.teamChatAgentConversation(
            input.connection,
            input.teamId,
            result.run.id,
          ),
          refreshThread(threadId),
          refreshThreads(),
        ]);
        setState((current) => ({
          ...current,
          agentConversation,
          busy: false,
        }));
        return true;
      } catch (error) {
        setState((current) => ({
          ...current,
          busy: false,
          error: errorMessage(error),
        }));
        return false;
      }
    },
    [
      input.connection,
      input.teamId,
      refreshThread,
      refreshThreads,
      state.agentConversation,
    ],
  );

  const closeAiThread = useCallback(() => {
    aiSelectionVersionRef.current += 1;
    aiConversationIdRef.current = null;
    setState((current) => ({ ...current, aiThread: null }));
  }, []);

  const sendAiTurn = useCallback(
    async (params: { body: string; providerId: string; modelId: string }): Promise<boolean> => {
      const conversationId = aiConversationIdRef.current;
      if (!input.connection || !input.teamId || !conversationId || !params.body.trim())
        return false;
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const aiThread = await api.sendTeamChatAiTurn(input.connection, conversationId, {
          teamId: input.teamId,
          body: params.body.trim(),
          clientRequestId: crypto.randomUUID(),
          providerId: params.providerId,
          modelId: params.modelId,
        });
        setState((current) => ({
          ...applySelectedTeamChatAiThread(
            current,
            aiThread,
            aiConversationIdRef.current,
          ),
          busy: false,
        }));
        if (aiThread.activeTurn) {
          await api.executeTeamChatAiTurn(input.connection, aiThread.activeTurn.id, input.teamId);
        }
        return true;
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: errorMessage(error) }));
        return false;
      }
    },
    [input.connection, input.teamId],
  );

  const stopAiTurn = useCallback(async (): Promise<boolean> => {
    const turnId = state.aiThread?.activeTurn?.id;
    if (!input.connection || !input.teamId || !turnId) return false;
    const result = await api.cancelTeamChatAiTurnExecution(input.connection, turnId, input.teamId);
    return result.cancelled;
  }, [input.connection, input.teamId, state.aiThread?.activeTurn?.id]);

  const editMessage = useCallback(
    async (message: TeamChatMessage, body: string) => {
      if (!input.connection || !input.teamId) return false;
      try {
        await api.editTeamChatMessage(input.connection, message.threadId, message.id, {
          teamId: input.teamId,
          body,
        });
        await refreshThread(message.threadId);
        return true;
      } catch (error) {
        setState((current) => ({ ...current, error: errorMessage(error) }));
        return false;
      }
    },
    [input.connection, input.teamId, refreshThread],
  );

  const deleteMessage = useCallback(
    async (message: TeamChatMessage) => {
      if (!input.connection || !input.teamId) return false;
      try {
        await api.deleteTeamChatMessage(
          input.connection,
          message.threadId,
          message.id,
          input.teamId,
        );
        await refreshThread(message.threadId);
        return true;
      } catch (error) {
        setState((current) => ({ ...current, error: errorMessage(error) }));
        return false;
      }
    },
    [input.connection, input.teamId, refreshThread],
  );

  const retryMessage = useCallback(
    async (message: TeamChatMessage): Promise<boolean> => {
      if (
        !input.connection ||
        !input.teamId ||
        !message.clientRequestId ||
        !message.id.startsWith("pending:")
      ) {
        return false;
      }
      const mentionUserIds = Array.isArray(message.metadata.mentionUserIds)
        ? message.metadata.mentionUserIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const pendingAttachments = pendingAttachmentsRef.current.get(message.clientRequestId);
      const replyRef = message.refs.find((ref) => ref.refType === "message_reply");
      updatePendingMessageDelivery(pendingMessagesRef.current, message.clientRequestId, "sending");
      setState((current) =>
        updateOptimisticDeliveryStatus(current, message.clientRequestId!, "sending"),
      );
      try {
        let uploaded = pendingAttachments?.uploaded ?? [];
        if (pendingAttachments && !pendingAttachments.uploaded) {
          uploaded = [];
          for (const [index, attachment] of pendingAttachments.inputs.entries()) {
            uploaded.push(
              await api.uploadTeamChatAttachment(input.connection, message.threadId, {
                teamId: input.teamId,
                attachment,
              }),
            );
            updatePendingMessageUploadProgress(
              pendingMessagesRef.current,
              message.clientRequestId,
              `${index + 1} of ${pendingAttachments.inputs.length}`,
            );
            setState((current) =>
              updateOptimisticUploadProgress(
                current,
                message.clientRequestId!,
                `${index + 1} of ${pendingAttachments.inputs.length}`,
              ),
            );
          }
          pendingAttachments.uploaded = uploaded;
        }
        const canonical = await api.sendTeamChatMessage(input.connection, message.threadId, {
          teamId: input.teamId,
          body: message.body,
          clientRequestId: message.clientRequestId,
          mentionUserIds,
          attachmentIds: uploaded.map((attachment) => attachment.id),
          replyToMessageId: replyRef?.refId ?? null,
        });
        pendingAttachmentsRef.current.delete(message.clientRequestId);
        pendingMessagesRef.current.delete(message.clientRequestId);
        setState((current) => applyCanonicalMessage(current, canonical, input.currentUserId));
        return true;
      } catch (error) {
        updatePendingMessageDelivery(pendingMessagesRef.current, message.clientRequestId, "failed");
        setState((current) => ({
          ...updateOptimisticDeliveryStatus(current, message.clientRequestId!, "failed"),
          error: errorMessage(error),
        }));
        return false;
      }
    },
    [input.connection, input.currentUserId, input.teamId],
  );

  const dismissFailedMessage = useCallback((message: TeamChatMessage) => {
    if (!message.id.startsWith("pending:")) return;
    if (message.clientRequestId) pendingAttachmentsRef.current.delete(message.clientRequestId);
    if (message.clientRequestId) pendingMessagesRef.current.delete(message.clientRequestId);
    setState((current) => removeOptimisticMessage(current, message.id));
  }, []);

  const setThreadMuted = useCallback(
    async (threadId: string, muted: boolean): Promise<boolean> => {
      if (!input.connection || !input.teamId) return false;
      try {
        const result = await api.setTeamChatThreadMuted(
          input.connection,
          threadId,
          input.teamId,
          muted,
        );
        const applyMute = <Thread extends { id: string; mutedAt: string | null }>(
          thread: Thread,
        ): Thread =>
          thread.id === result.threadId
            ? { ...thread, mutedAt: result.mutedAt }
            : thread;
        setState((current) => ({
          ...current,
          threads: current.threads.map(applyMute),
          detail:
            current.detail?.thread.id === result.threadId
              ? {
                  ...current.detail,
                  thread: applyMute(current.detail.thread),
                }
              : current.detail,
          error: null,
        }));
        return true;
      } catch (error) {
        setState((current) => ({ ...current, error: errorMessage(error) }));
        return false;
      }
    },
    [input.connection, input.teamId],
  );

  return {
    ...state,
    currentUserId: input.currentUserId,
    notificationMode,
    incomingNotification,
    setNotificationMode,
    dismissIncomingNotification,
    setThreadMuted,
    selectThread,
    openDm,
    loadMoreMessages,
    sendMessage,
    openAiThread,
    openAgentConversation,
    closeAgentConversation,
    sendAgentTurn,
    closeAiThread,
    sendAiTurn,
    stopAiTurn,
    editMessage,
    deleteMessage,
    retryMessage,
    dismissFailedMessage,
    refresh: async () => {
      await Promise.all([
        refreshDirectory(),
        refreshThreads(),
        refreshThread(),
        refreshAiThread(),
        refreshAgentConversation(),
      ]);
    },
  };
}

function errorMessage(error: unknown): string {
  return teamChatErrorMessage(error);
}
