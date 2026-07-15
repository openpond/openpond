import {
  CommunityMessageSchema,
  type ChatAttachment,
  type CommunityChannel,
  type CommunityEvent,
  type CommunityMember,
  type CommunityMessage,
  type CommunityNotificationMode,
  type CommunityPreview,
} from "@openpond/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ClientConnection } from "../api";
import { openCommunityRealtime } from "../api/community-realtime";

type ChannelMessages = {
  items: CommunityMessage[];
  hasMoreBefore: boolean;
  preview: boolean;
};

export type CommunityIncomingNotification = {
  communityId: string;
  channelId: string;
  message: CommunityMessage;
};

export type CommunityFailedSend = {
  body: string;
  clientRequestId: string;
  mentionUserIds: string[];
  attachments: ChatAttachment[];
  replyToMessageId: string | null;
  message: string;
};

export function useCommunityChat(input: {
  connection: ClientConnection | null;
  preview: CommunityPreview | null;
  currentUserId: string | null;
  membershipVersion: number;
}) {
  const { connection, preview, currentUserId, membershipVersion } = input;
  const communityId = preview?.id ?? null;
  const memberActive = preview?.membership?.status === "active";
  const rulesAccepted = !preview?.capabilities.requiresRulesAcceptance;
  const [channels, setChannels] = useState<CommunityChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChannelMessages>>({});
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lostMembership, setLostMembership] = useState(false);
  const [failedSend, setFailedSend] = useState<CommunityFailedSend | null>(null);
  const [incomingNotification, setIncomingNotification] = useState<CommunityIncomingNotification | null>(null);
  const selectedChannelRef = useRef<string | null>(null);
  const channelsRef = useRef<CommunityChannel[]>([]);
  const notificationModeRef = useRef<CommunityNotificationMode>("mentions");
  const loadMessagesVersion = useRef(0);
  const markedReadRef = useRef<Record<string, number>>({});
  const seenEventIdsRef = useRef<Set<number>>(new Set());

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId],
  );
  const selectedMessages = selectedChannelId ? messagesByChannel[selectedChannelId] ?? null : null;

  useEffect(() => { selectedChannelRef.current = selectedChannelId; }, [selectedChannelId]);
  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => {
    notificationModeRef.current = preview?.membership?.notificationMode ?? "mentions";
  }, [preview?.membership?.notificationMode]);

  const loadChannels = useCallback(async () => {
    if (!connection || !communityId) return false;
    setChannelsLoading(true);
    setChannelsError(null);
    try {
      const result = await api.communityChannels(connection, communityId);
      setChannels(result.channels);
      setSelectedChannelId((current) => {
        if (current && result.channels.some((channel) => channel.id === current)) return current;
        return result.channels.find((channel) => channel.isDefault)?.id ?? result.channels[0]?.id ?? null;
      });
      setLostMembership(false);
      return true;
    } catch (error) {
      const message = messageFor(error);
      setChannelsError(message);
      if (isMembershipError(message)) setLostMembership(true);
      return false;
    } finally {
      setChannelsLoading(false);
    }
  }, [communityId, connection]);

  const loadMessages = useCallback(async (channelId: string) => {
    if (!connection || !communityId) return false;
    const version = ++loadMessagesVersion.current;
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const page = await api.communityMessages(connection, communityId, channelId, { limit: 50 });
      if (version !== loadMessagesVersion.current) return false;
      setMessagesByChannel((current) => ({
        ...current,
        [channelId]: {
          items: page.messages,
          hasMoreBefore: page.hasMoreBefore,
          preview: page.preview,
        },
      }));
      setLostMembership(false);
      return true;
    } catch (error) {
      if (version !== loadMessagesVersion.current) return false;
      const message = messageFor(error);
      setMessagesError(message);
      if (isMembershipError(message)) setLostMembership(true);
      return false;
    } finally {
      if (version === loadMessagesVersion.current) setMessagesLoading(false);
    }
  }, [communityId, connection]);

  useEffect(() => {
    setChannels(preview?.channels ?? []);
    setMessagesByChannel({});
    setSelectedChannelId(preview?.channels.find((channel) => channel.isDefault)?.id ?? preview?.channels[0]?.id ?? null);
    setChannelsError(null);
    setMessagesError(null);
    setRealtimeError(null);
    setLostMembership(false);
    seenEventIdsRef.current.clear();
    if (communityId) void loadChannels();
  }, [communityId, loadChannels, membershipVersion]);

  useEffect(() => {
    if (!selectedChannelId) return;
    void loadMessages(selectedChannelId);
  }, [loadMessages, selectedChannelId]);

  const markRead = useCallback(async (channelId: string, sequence: number) => {
    if (!connection || !communityId || !memberActive || !rulesAccepted || sequence <= 0) return false;
    if ((markedReadRef.current[channelId] ?? 0) >= sequence) return true;
    markedReadRef.current[channelId] = sequence;
    try {
      const result = await api.markCommunityRead(connection, communityId, channelId, sequence);
      setChannels((current) => current.map((channel) => channel.id === channelId
        ? {
            ...channel,
            unreadCount: 0,
            readState: channel.readState
              ? { ...channel.readState, lastReadSequence: result.sequence, lastReadAt: new Date().toISOString() }
              : { lastReadSequence: result.sequence, lastReadAt: new Date().toISOString(), mutedAt: null, pinnedAt: null },
          }
        : channel));
      return true;
    } catch (error) {
      const message = messageFor(error);
      if (isMembershipError(message)) setLostMembership(true);
      return false;
    }
  }, [communityId, connection, memberActive, rulesAccepted]);

  useEffect(() => {
    const latest = selectedMessages?.items.at(-1)?.sequence ?? 0;
    if (selectedChannelId && latest > 0) void markRead(selectedChannelId, latest);
  }, [markRead, selectedChannelId, selectedMessages?.items]);

  const applyEvent = useCallback((event: CommunityEvent) => {
    if (event.communityId !== communityId) return;
    if (seenEventIdsRef.current.has(event.id)) return;
    seenEventIdsRef.current.add(event.id);
    const parsedMessage = CommunityMessageSchema.safeParse(event.payload.message);
    if (parsedMessage.success && event.type !== "read.updated") {
      const message = parsedMessage.data;
      setMessagesByChannel((current) => {
        const state = current[event.channelId];
        if (!state) return current;
        const found = state.items.some((item) => item.id === message.id);
        const items = found
          ? state.items.map((item) => item.id === message.id ? message : item)
          : [...state.items, message].sort((left, right) => left.sequence - right.sequence);
        return { ...current, [event.channelId]: { ...state, items } };
      });
      setChannels((current) => current.map((channel) => channel.id === event.channelId
        ? {
            ...channel,
            lastMessageSequence: Math.max(channel.lastMessageSequence, message.sequence),
            unreadCount:
              selectedChannelRef.current === event.channelId || message.authorUserId === currentUserId
                ? 0
                : Math.max(channel.unreadCount + (event.type === "message.created" ? 1 : 0), 0),
          }
        : channel));
      if (event.type === "message.created" && message.authorUserId !== currentUserId) {
        const channel = channelsRef.current.find((item) => item.id === event.channelId);
        const mentioned = mentionIds(message).includes(currentUserId ?? "");
        const mode = notificationModeRef.current;
        if (!channel?.readState?.mutedAt && (mode === "all" || (mode === "mentions" && mentioned))) {
          setIncomingNotification({ communityId: event.communityId, channelId: event.channelId, message });
        }
      }
      if (selectedChannelRef.current === event.channelId) void markRead(event.channelId, message.sequence);
      return;
    }
    if (event.type === "read.updated" && event.payload.userId === currentUserId) void loadChannels();
  }, [communityId, currentUserId, loadChannels, markRead]);

  useEffect(() => {
    if (!connection || !communityId || !memberActive || !rulesAccepted) return;
    let disposed = false;
    let close: (() => void) | null = null;
    setRealtimeError(null);
    void Promise.all([
      api.communityRealtimeSession(connection, communityId),
      api.communityEvents(connection, communityId),
    ]).then(async ([session, baseline]) => {
      if (disposed) return;
      const recover = async () => {
        let cursor = baseline.cursor;
        for (;;) {
          const page = await api.communityEvents(connection, communityId, { after: cursor, limit: 200 });
          if (disposed) return;
          for (const event of page.events) applyEvent(event);
          cursor = page.cursor;
          if (!page.hasMore) return;
        }
      };
      const handle = openCommunityRealtime({
        session,
        onEvent: applyEvent,
        onReady: () => {
          setRealtimeError(null);
          void recover().catch((error) => setRealtimeError(messageFor(error)));
        },
        onError: (error) => setRealtimeError(messageFor(error)),
      });
      close = () => handle.close();
      await recover();
    }).catch((error) => {
      if (!disposed) {
        const message = messageFor(error);
        setRealtimeError(message);
        if (isMembershipError(message)) setLostMembership(true);
      }
    });
    return () => {
      disposed = true;
      close?.();
    };
  }, [applyEvent, communityId, connection, memberActive, membershipVersion, rulesAccepted]);

  const loadOlder = useCallback(async () => {
    if (!connection || !communityId || !selectedChannelId || olderMessagesLoading) return false;
    const state = messagesByChannel[selectedChannelId];
    const beforeSequence = state?.items[0]?.sequence;
    if (!state?.hasMoreBefore || beforeSequence == null) return false;
    setOlderMessagesLoading(true);
    setMessagesError(null);
    try {
      const page = await api.communityMessages(connection, communityId, selectedChannelId, { beforeSequence, limit: 50 });
      setMessagesByChannel((current) => {
        const existing = current[selectedChannelId] ?? state;
        const ids = new Set(existing.items.map((item) => item.id));
        return {
          ...current,
          [selectedChannelId]: {
            ...existing,
            items: [...page.messages.filter((item) => !ids.has(item.id)), ...existing.items],
            hasMoreBefore: page.hasMoreBefore,
          },
        };
      });
      return true;
    } catch (error) {
      setMessagesError(messageFor(error));
      return false;
    } finally {
      setOlderMessagesLoading(false);
    }
  }, [communityId, connection, messagesByChannel, olderMessagesLoading, selectedChannelId]);

  const performSend = useCallback(async (attempt: Omit<CommunityFailedSend, "message">) => {
    if (!connection || !communityId || !selectedChannelId || sending) return false;
    setSending(true);
    setActionError(null);
    setFailedSend(null);
    try {
      const uploaded = await Promise.all(attempt.attachments.map((attachment) =>
        api.uploadCommunityAttachment(connection, communityId, selectedChannelId, attachment)));
      const message = await api.sendCommunityMessage(connection, communityId, selectedChannelId, {
        body: attempt.body,
        clientRequestId: attempt.clientRequestId,
        mentionUserIds: attempt.mentionUserIds,
        attachmentIds: uploaded.map((attachment) => attachment.id),
        replyToMessageId: attempt.replyToMessageId,
      });
      setMessagesByChannel((current) => {
        const state = current[selectedChannelId] ?? { items: [], hasMoreBefore: false, preview: false };
        return state.items.some((item) => item.id === message.id)
          ? current
          : { ...current, [selectedChannelId]: { ...state, items: [...state.items, message] } };
      });
      await markRead(selectedChannelId, message.sequence);
      return true;
    } catch (error) {
      const message = messageFor(error);
      setActionError(message);
      setFailedSend({ ...attempt, message });
      if (isMembershipError(message)) setLostMembership(true);
      return false;
    } finally {
      setSending(false);
    }
  }, [communityId, connection, markRead, selectedChannelId, sending]);

  const sendMessage = useCallback((input: {
    body: string;
    mentionUserIds?: string[];
    attachments?: ChatAttachment[];
    replyToMessageId?: string | null;
  }) => performSend({
    body: input.body,
    clientRequestId: crypto.randomUUID(),
    mentionUserIds: input.mentionUserIds ?? [],
    attachments: input.attachments ?? [],
    replyToMessageId: input.replyToMessageId ?? null,
  }), [performSend]);

  const editMessage = useCallback(async (messageId: string, body: string) => {
    if (!connection || !communityId || !selectedChannelId) return false;
    setActionError(null);
    try {
      const message = await api.editCommunityMessage(connection, communityId, selectedChannelId, messageId, body);
      replaceMessage(setMessagesByChannel, selectedChannelId, message);
      return true;
    } catch (error) {
      setActionError(messageFor(error));
      return false;
    }
  }, [communityId, connection, selectedChannelId]);

  const deleteMessage = useCallback(async (messageId: string) => {
    if (!connection || !communityId || !selectedChannelId) return false;
    setActionError(null);
    try {
      const message = await api.deleteCommunityMessage(connection, communityId, selectedChannelId, messageId);
      replaceMessage(setMessagesByChannel, selectedChannelId, message);
      return true;
    } catch (error) {
      setActionError(messageFor(error));
      return false;
    }
  }, [communityId, connection, selectedChannelId]);

  const setMuted = useCallback(async (channelId: string, muted: boolean) => {
    if (!connection || !communityId) return false;
    setActionError(null);
    try {
      const result = await api.setCommunityChannelMuted(connection, communityId, channelId, muted);
      setChannels((current) => current.map((channel) => channel.id === channelId && channel.readState
        ? { ...channel, readState: { ...channel.readState, mutedAt: result.mutedAt } }
        : channel));
      return true;
    } catch (error) {
      setActionError(messageFor(error));
      return false;
    }
  }, [communityId, connection]);

  const searchMembers = useCallback(async (query = "") => {
    if (!connection || !communityId || !memberActive) return [];
    try {
      const result = await api.searchCommunityMembers(connection, communityId, { query, limit: 50 });
      setMembers((current) => mergeMembers(current, result.items));
      return result.items;
    } catch (error) {
      setActionError(messageFor(error));
      return [];
    }
  }, [communityId, connection, memberActive]);

  useEffect(() => {
    if (memberActive && rulesAccepted) void searchMembers();
    else setMembers([]);
  }, [memberActive, rulesAccepted, searchMembers]);

  const downloadAttachment = useCallback(async (attachmentId: string) => {
    if (!connection || !communityId || !selectedChannelId) return false;
    try {
      const result = await api.communityAttachmentDownload(connection, communityId, selectedChannelId, attachmentId);
      window.open(result.url, "_blank", "noopener,noreferrer");
      return true;
    } catch (error) {
      setActionError(messageFor(error));
      return false;
    }
  }, [communityId, connection, selectedChannelId]);

  const loadSelectedMessages = useCallback(
    () => selectedChannelId ? loadMessages(selectedChannelId) : Promise.resolve(false),
    [loadMessages, selectedChannelId],
  );
  const retrySend = useCallback(
    () => failedSend ? performSend(failedSend) : Promise.resolve(false),
    [failedSend, performSend],
  );
  const dismissFailedSend = useCallback(() => setFailedSend(null), []);
  const dismissIncomingNotification = useCallback(() => setIncomingNotification(null), []);

  return {
    channels,
    selectedChannelId,
    selectedChannel,
    messages: selectedMessages?.items ?? [],
    hasMoreBefore: selectedMessages?.hasMoreBefore ?? false,
    previewMode: selectedMessages?.preview ?? !memberActive,
    members,
    channelsLoading,
    messagesLoading,
    olderMessagesLoading,
    sending,
    channelsError,
    messagesError,
    realtimeError,
    actionError,
    lostMembership,
    failedSend,
    incomingNotification,
    selectChannel: setSelectedChannelId,
    loadChannels,
    loadMessages: loadSelectedMessages,
    loadOlder,
    sendMessage,
    retrySend,
    dismissFailedSend,
    editMessage,
    deleteMessage,
    setMuted,
    searchMembers,
    downloadAttachment,
    dismissIncomingNotification,
  };
}

function replaceMessage(
  setState: React.Dispatch<React.SetStateAction<Record<string, ChannelMessages>>>,
  channelId: string,
  message: CommunityMessage,
) {
  setState((current) => {
    const state = current[channelId];
    if (!state) return current;
    return { ...current, [channelId]: { ...state, items: state.items.map((item) => item.id === message.id ? message : item) } };
  });
}

function mentionIds(message: CommunityMessage): string[] {
  const ids = message.metadata.mentionUserIds;
  return Array.isArray(ids) ? ids.filter((value): value is string => typeof value === "string") : [];
}

function mergeMembers(current: CommunityMember[], incoming: CommunityMember[]): CommunityMember[] {
  const merged = new Map(current.map((member) => [member.userId, member]));
  for (const member of incoming) merged.set(member.userId, member);
  return [...merged.values()].slice(-200);
}

function isMembershipError(message: string): boolean {
  return message.includes("community_membership_required") || message.includes("community_rules");
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
