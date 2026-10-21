import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { api, type ClientConnection, type PreferencesPayload } from "../api";
import { normalizePreferences } from "../lib/app-models";
import { DEFAULT_DIFF_PANEL_WIDTH, DEFAULT_SIDEBAR_WIDTH, clampDiffPanelWidth, clampSidebarWidth } from "../lib/layout";
import { createLayoutPreferenceWriter, type LayoutPreferenceWriter } from "../lib/layout-preference-writer";
import {
  mergeLayoutWidthPreferencePreservingRecentLocal,
  mergeSidebarSectionsCollapsedPreservingRecentLocal,
  recordLayoutWidthPreferenceChange,
  recordSidebarSectionPreferenceChanges,
  type LayoutWidthPreferenceChange,
  type SidebarSectionPreferenceChangeTimes,
} from "../lib/sidebar-preference-state";

type SidebarSectionsCollapsed = BootstrapPayload["preferences"]["sidebarSectionsCollapsed"];

type UseLayoutPreferencesInput = {
  connection: ClientConnection | null;
  preferences: BootstrapPayload["preferences"] | undefined;
  sidebarOpen: boolean;
  diffPanelExpanded: boolean;
  setBootstrap: Dispatch<SetStateAction<BootstrapPayload | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useLayoutPreferences({
  connection,
  preferences,
  sidebarOpen,
  diffPanelExpanded,
  setBootstrap,
  setError,
}: UseLayoutPreferencesInput) {
  const [sidebarSectionsCollapsed, setSidebarSectionsCollapsed] = useState<SidebarSectionsCollapsed>(
    () => normalizePreferences().sidebarSectionsCollapsed,
  );
  const sidebarSectionsCollapsedRef = useRef(sidebarSectionsCollapsed);
  const sidebarSectionChangeTimesRef = useRef<SidebarSectionPreferenceChangeTimes>({});
  const sidebarWidthChangeRef = useRef<LayoutWidthPreferenceChange | null>(null);
  const diffPanelWidthChangeRef = useRef<LayoutWidthPreferenceChange | null>(null);
  const preferenceWriterRef = useRef<LayoutPreferenceWriter | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [diffPanelWidth, setDiffPanelWidth] = useState(DEFAULT_DIFF_PANEL_WIDTH);
  const [diffPanelResizing, setDiffPanelResizing] = useState(false);
  const {
    projects: projectsCollapsed,
    cloudProjects: cloudProjectsCollapsed,
    chats: chatsCollapsed,
    savedForLater: savedForLaterCollapsed,
  } = sidebarSectionsCollapsed;

  useEffect(() => {
    if (sidebarResizing) return;
    const incoming = clampSidebarWidth(normalizePreferences(preferences).sidebarWidth);
    const next = mergeLayoutWidthPreferencePreservingRecentLocal(incoming, sidebarWidthChangeRef.current);
    sidebarWidthChangeRef.current = next.localChange;
    setSidebarWidth(next.value);
  }, [preferences, sidebarResizing]);

  useEffect(() => {
    if (diffPanelResizing) return;
    const incoming = clampDiffPanelWidth(normalizePreferences(preferences).diffPanelWidth);
    const next = mergeLayoutWidthPreferencePreservingRecentLocal(incoming, diffPanelWidthChangeRef.current);
    diffPanelWidthChangeRef.current = next.localChange;
    setDiffPanelWidth(next.value);
  }, [diffPanelResizing, preferences]);

  useEffect(() => {
    const incoming = normalizePreferences(preferences).sidebarSectionsCollapsed;
    setSidebarSectionsCollapsed((current) => {
      const next = mergeSidebarSectionsCollapsedPreservingRecentLocal(
        current,
        incoming,
        sidebarSectionChangeTimesRef.current,
      );
      sidebarSectionsCollapsedRef.current = next;
      return next;
    });
  }, [preferences]);

  const updatePreferencePayload = useCallback(
    (payload: PreferencesPayload) => {
      setBootstrap((current) => (current ? { ...current, preferences: payload.preferences } : current));
    },
    [setBootstrap]
  );

  useEffect(() => {
    if (!connection) return;
    const writer = createLayoutPreferenceWriter({
      save: patch => api.savePreferences(connection, patch),
      apply: updatePreferencePayload,
      onError: error => setError(error instanceof Error ? error.message : String(error)),
    });
    preferenceWriterRef.current = writer;
    return () => { writer.dispose(); preferenceWriterRef.current = null; };
  }, [connection, setError, updatePreferencePayload]);

  // A restored width can equal an older bootstrap value while another save is
  // pending. Always queue the gesture instead of treating that value as saved.
  const persistSidebarWidth = useCallback((width: number) =>
    preferenceWriterRef.current?.write({ sidebarWidth: width }), []);
  const persistDiffPanelWidth = useCallback((width: number) =>
    preferenceWriterRef.current?.write({ diffPanelWidth: width }), []);
  const persistSidebarSectionsCollapsed = useCallback((sidebarSectionsCollapsed: SidebarSectionsCollapsed) =>
    preferenceWriterRef.current?.write({ sidebarSectionsCollapsed }), []);

  const updateSidebarSectionsCollapsed = useCallback(
    (next: SidebarSectionsCollapsed) => {
      const previous = sidebarSectionsCollapsedRef.current;
      recordSidebarSectionPreferenceChanges(sidebarSectionChangeTimesRef.current, previous, next);
      sidebarSectionsCollapsedRef.current = next;
      setSidebarSectionsCollapsed(next);
      void persistSidebarSectionsCollapsed(next);
    },
    [persistSidebarSectionsCollapsed]
  );

  const toggleProjectsCollapsed = useCallback(() => {
    const current = sidebarSectionsCollapsedRef.current;
    updateSidebarSectionsCollapsed({ ...current, projects: !current.projects });
  }, [updateSidebarSectionsCollapsed]);

  const toggleCloudProjectsCollapsed = useCallback(() => {
    const current = sidebarSectionsCollapsedRef.current;
    updateSidebarSectionsCollapsed({ ...current, cloudProjects: !current.cloudProjects });
  }, [updateSidebarSectionsCollapsed]);

  const toggleChatsCollapsed = useCallback(() => {
    const current = sidebarSectionsCollapsedRef.current;
    updateSidebarSectionsCollapsed({ ...current, chats: !current.chats });
  }, [updateSidebarSectionsCollapsed]);

  const toggleSavedForLaterCollapsed = useCallback(() => {
    const current = sidebarSectionsCollapsedRef.current;
    updateSidebarSectionsCollapsed({ ...current, savedForLater: !current.savedForLater });
  }, [updateSidebarSectionsCollapsed]);

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!sidebarOpen) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      let latestWidth = startWidth;
      setSidebarResizing(true);

      function onPointerMove(moveEvent: PointerEvent) {
        latestWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
        setSidebarWidth(latestWidth);
      }

      function onPointerUp() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        const localChange = recordLayoutWidthPreferenceChange(startWidth, latestWidth);
        if (localChange) sidebarWidthChangeRef.current = localChange;
        setSidebarResizing(false);
        void persistSidebarWidth(latestWidth);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
    },
    [persistSidebarWidth, sidebarOpen, sidebarWidth]
  );

  const startDiffPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (diffPanelExpanded || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);
      const startX = event.clientX;
      const startWidth = diffPanelWidth;
      let latestWidth = startWidth;
      setDiffPanelResizing(true);

      function onPointerMove(moveEvent: PointerEvent) {
        latestWidth = clampDiffPanelWidth(startWidth - (moveEvent.clientX - startX));
        setDiffPanelWidth(latestWidth);
      }

      function onPointerUp() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        handle.removeEventListener("lostpointercapture", onPointerUp);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        const localChange = recordLayoutWidthPreferenceChange(startWidth, latestWidth);
        if (localChange) diffPanelWidthChangeRef.current = localChange;
        setDiffPanelResizing(false);
        void persistDiffPanelWidth(latestWidth);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
      window.addEventListener("pointercancel", onPointerUp, { once: true });
      handle.addEventListener("lostpointercapture", onPointerUp, { once: true });
    },
    [diffPanelExpanded, diffPanelWidth, persistDiffPanelWidth]
  );

  return {
    projectsCollapsed,
    cloudProjectsCollapsed,
    chatsCollapsed,
    savedForLaterCollapsed,
    sidebarWidth,
    sidebarResizing,
    diffPanelWidth,
    diffPanelResizing,
    toggleProjectsCollapsed,
    toggleCloudProjectsCollapsed,
    toggleChatsCollapsed,
    toggleSavedForLaterCollapsed,
    startSidebarResize,
    startDiffPanelResize,
  };
}
