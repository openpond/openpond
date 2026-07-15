import type {
  CommunityNotificationMode,
  CommunityPreview,
  CommunitySummary,
} from "@openpond/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ClientConnection } from "../api";

export type CommunityMembershipErrorKind =
  | "rules_stale"
  | "membership_lost"
  | "join_conflict"
  | "unknown";

export type CommunityMembershipError = {
  kind: CommunityMembershipErrorKind;
  message: string;
};

export function useCommunities(input: {
  connection: ClientConnection | null;
  refreshToken?: string | null;
}) {
  const { connection, refreshToken = null } = input;
  const [items, setItems] = useState<CommunitySummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CommunityPreview | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [membershipError, setMembershipError] = useState<CommunityMembershipError | null>(null);
  const [membershipVersion, setMembershipVersion] = useState(0);
  const selectionVersion = useRef(0);

  const selectedSummary = useMemo(
    () => items.find((community) => community.id === selectedCommunityId) ?? null,
    [items, selectedCommunityId],
  );

  const refresh = useCallback(async () => {
    if (!connection) return false;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try {
      const page = await api.communities(connection);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setSelectedCommunityId((current) => current && page.items.some((item) => item.id === current) ? current : null);
      return true;
    } catch (error) {
      setDiscoveryError(messageFor(error));
      return false;
    } finally {
      setDiscoveryLoading(false);
    }
  }, [connection]);

  const loadMore = useCallback(async () => {
    if (!connection || !nextCursor || discoveryLoading) return false;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try {
      const page = await api.communities(connection, nextCursor);
      setItems((current) => mergeCommunities(current, page.items));
      setNextCursor(page.nextCursor);
      return true;
    } catch (error) {
      setDiscoveryError(messageFor(error));
      return false;
    } finally {
      setDiscoveryLoading(false);
    }
  }, [connection, discoveryLoading, nextCursor]);

  const loadPreview = useCallback(async (community: CommunitySummary) => {
    if (!connection) return null;
    const version = ++selectionVersion.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await api.communityPreview(connection, community.slug);
      if (selectionVersion.current === version) setPreview(result);
      return result;
    } catch (error) {
      if (selectionVersion.current === version) setPreviewError(messageFor(error));
      return null;
    } finally {
      if (selectionVersion.current === version) setPreviewLoading(false);
    }
  }, [connection]);

  const selectCommunity = useCallback((communityId: string) => {
    const community = items.find((item) => item.id === communityId);
    if (!community) return;
    setSelectedCommunityId(community.id);
    setPreview((current) => current?.id === community.id ? current : null);
    setMembershipError(null);
    void loadPreview(community);
  }, [items, loadPreview]);

  const showDiscovery = useCallback(() => {
    selectionVersion.current += 1;
    setSelectedCommunityId(null);
    setPreview(null);
    setPreviewError(null);
    setMembershipError(null);
  }, []);

  useEffect(() => {
    if (!connection) {
      setItems([]);
      setPreview(null);
      setSelectedCommunityId(null);
      return;
    }
    void refresh();
  }, [connection, refresh, refreshToken]);

  useEffect(() => {
    if (!selectedSummary || preview?.id === selectedSummary.id || previewLoading) return;
    void loadPreview(selectedSummary);
  }, [loadPreview, preview?.id, previewLoading, selectedSummary]);

  const reconcileSelected = useCallback(async () => {
    const selected = selectedSummary;
    await refresh();
    if (selected) await loadPreview(selected);
  }, [loadPreview, refresh, selectedSummary]);

  const join = useCallback(async () => {
    if (!connection || !preview?.currentRules || membershipBusy) return false;
    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await api.joinCommunity(connection, preview.id, preview.currentRules.id);
      setMembershipVersion((version) => version + 1);
      await reconcileSelected();
      return true;
    } catch (error) {
      const parsed = membershipErrorFor(error);
      setMembershipError(parsed);
      if (parsed.kind === "rules_stale") await reconcileSelected();
      return false;
    } finally {
      setMembershipBusy(false);
    }
  }, [connection, membershipBusy, preview, reconcileSelected]);

  const acceptRules = useCallback(async () => {
    if (!connection || !preview?.currentRules || membershipBusy) return false;
    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await api.acceptCommunityRules(connection, preview.id, preview.currentRules.id);
      setMembershipVersion((version) => version + 1);
      await reconcileSelected();
      return true;
    } catch (error) {
      const parsed = membershipErrorFor(error);
      setMembershipError(parsed);
      if (parsed.kind === "rules_stale") await reconcileSelected();
      return false;
    } finally {
      setMembershipBusy(false);
    }
  }, [connection, membershipBusy, preview, reconcileSelected]);

  const leave = useCallback(async () => {
    if (!connection || !preview || membershipBusy) return false;
    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await api.leaveCommunity(connection, preview.id);
      setMembershipVersion((version) => version + 1);
      await reconcileSelected();
      return true;
    } catch (error) {
      setMembershipError(membershipErrorFor(error));
      return false;
    } finally {
      setMembershipBusy(false);
    }
  }, [connection, membershipBusy, preview, reconcileSelected]);

  const updateNotifications = useCallback(async (mode: CommunityNotificationMode) => {
    if (!connection || !preview || membershipBusy) return false;
    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await api.updateCommunityNotifications(connection, preview.id, mode);
      setItems((current) => current.map((item) => item.id === preview.id && item.membership
        ? { ...item, membership: { ...item.membership, notificationMode: mode } }
        : item));
      setPreview((current) => current?.id === preview.id && current.membership
        ? { ...current, membership: { ...current.membership, notificationMode: mode } }
        : current);
      return true;
    } catch (error) {
      setMembershipError(membershipErrorFor(error));
      return false;
    } finally {
      setMembershipBusy(false);
    }
  }, [connection, membershipBusy, preview]);

  return {
    items,
    nextCursor,
    selectedCommunityId,
    selectedSummary,
    preview,
    discoveryLoading,
    previewLoading,
    membershipBusy,
    discoveryError,
    previewError,
    membershipError,
    membershipVersion,
    refresh,
    loadMore,
    showDiscovery,
    selectCommunity,
    join,
    acceptRules,
    leave,
    updateNotifications,
    clearMembershipError: () => setMembershipError(null),
  };
}

function mergeCommunities(current: CommunitySummary[], incoming: CommunitySummary[]): CommunitySummary[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function membershipErrorFor(error: unknown): CommunityMembershipError {
  const message = messageFor(error);
  if (message.includes("community_rules_version_stale")) {
    return { kind: "rules_stale", message: "The community rules changed. Review the newest version and try again." };
  }
  if (message.includes("community_membership_required")) {
    return { kind: "membership_lost", message: "Your community membership is no longer active." };
  }
  if (message.includes("community_join_closed") || message.includes("community_invalid_request")) {
    return { kind: "join_conflict", message: "The community could not be joined in its current state." };
  }
  return { kind: "unknown", message };
}
