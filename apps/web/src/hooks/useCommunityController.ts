import { useCallback, useEffect } from "react";
import type { ClientConnection } from "../api";
import type { ShowAppToast } from "../app/app-state";
import type { AppView } from "../lib/app-models";
import { useCommunities } from "./useCommunities";
import { useCommunityChat } from "./useCommunityChat";

export function useCommunityController(input: {
  connection: ClientConnection | null;
  currentUserId: string | null;
  refreshToken: string | null;
  setView: (view: AppView) => void;
  showToast: ShowAppToast;
}) {
  const communities = useCommunities({
    connection: input.connection,
    refreshToken: input.refreshToken,
  });
  const chat = useCommunityChat({
    connection: input.connection,
    preview: communities.preview,
    currentUserId: input.currentUserId,
    membershipVersion: communities.membershipVersion,
  });
  const notification = chat.incomingNotification;
  const communityItems = communities.items;
  const communityChannels = chat.channels;
  const selectCommunity = communities.selectCommunity;
  const selectChannel = chat.selectChannel;
  const dismissIncomingNotification = chat.dismissIncomingNotification;
  const { setView, showToast } = input;
  const discoverCommunities = useCallback(() => {
    communities.showDiscovery();
    setView("community");
  }, [communities.showDiscovery, setView]);
  const selectCommunityForSidebar = useCallback((communityId: string) => {
    communities.selectCommunity(communityId);
    setView("community");
  }, [communities.selectCommunity, setView]);
  const selectCommunityChannelForSidebar = useCallback((channelId: string) => {
    chat.selectChannel(channelId);
    setView("community");
  }, [chat.selectChannel, setView]);

  useEffect(() => {
    if (!notification) return;
    const community = communityItems.find((item) => item.id === notification.communityId);
    const channel = communityChannels.find((item) => item.id === notification.channelId);
    showToast(
      `${community?.displayName ?? "Community"} · #${channel?.displayName ?? "channel"}: ${notification.message.body.slice(0, 120) || "New message"}`,
      "info",
      {
        actionLabel: "View",
        onAction: () => {
          selectCommunity(notification.communityId);
          selectChannel(notification.channelId);
          setView("community");
        },
        placement: "top-right",
      },
    );
    dismissIncomingNotification();
  }, [
    communityChannels,
    communityItems,
    dismissIncomingNotification,
    notification,
    selectChannel,
    selectCommunity,
    setView,
    showToast,
  ]);

  return {
    communities,
    chat,
    sidebar: {
      communityItems: communities.items,
      communityChannels: chat.channels,
      communityLoading: communities.discoveryLoading,
      communityError: communities.discoveryError,
      selectedCommunityId: communities.selectedCommunityId,
      selectedCommunityChannelId: chat.selectedChannelId,
      discoverCommunities,
      selectCommunity: selectCommunityForSidebar,
      selectCommunityChannel: selectCommunityChannelForSidebar,
    },
    view: { communities, chat, currentUserId: input.currentUserId },
  };
}
