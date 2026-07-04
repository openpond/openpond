import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { normalizePreferences } from "../lib/app-models";
import { DEFAULT_DIFF_PANEL_WIDTH, DEFAULT_SIDEBAR_WIDTH, clampDiffPanelWidth, clampSidebarWidth } from "../lib/layout";
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
  diffPanelOpen: boolean;
  diffPanelExpanded: boolean;
  setBootstrap: Dispatch<SetStateAction<BootstrapPayload | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useLayoutPreferences({
  connection,
  preferences,
  sidebarOpen,
  diffPanelOpen,
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
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [diffPanelWidth, setDiffPanelWidth] = useState(DEFAULT_DIFF_PANEL_WIDTH);
  const [diffPanelResizing, setDiffPanelResizing] = useState(false);
  const {
    pinned: pinnedCollapsed,
    projects: projectsCollapsed,
    cloudProjects: cloudProjectsCollapsed,
    chats: chatsCollapsed,
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
    (payload: BootstrapPayload) => {
      setBootstrap((current) => (current ? { ...current, preferences: payload.preferences } : payload));
    },
    [setBootstrap]
  );

  const persistSidebarWidth = useCallback(
    async (width: number) => {
      if (!connection) return;
      try {
        updatePreferencePayload(await api.savePreferences(connection, { sidebarWidth: width }));
      } catch (preferenceError) {
        setError(preferenceError instanceof Error ? preferenceError.message : String(preferenceError));
      }
    },
    [connection, setError, updatePreferencePayload]
  );

  const persistDiffPanelWidth = useCallback(
    async (width: number) => {
      if (!connection) return;
      try {
        updatePreferencePayload(await api.savePreferences(connection, { diffPanelWidth: width }));
      } catch (preferenceError) {
        setError(preferenceError instanceof Error ? preferenceError.message : String(preferenceError));
      }
    },
    [connection, setError, updatePreferencePayload]
  );

  const persistSidebarSectionsCollapsed = useCallback(
    async (sidebarSectionsCollapsed: SidebarSectionsCollapsed) => {
      if (!connection) return;
      try {
        updatePreferencePayload(await api.savePreferences(connection, { sidebarSectionsCollapsed }));
      } catch (preferenceError) {
        setError(preferenceError instanceof Error ? preferenceError.message : String(preferenceError));
      }
    },
    [connection, setError, updatePreferencePayload]
  );

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

  const togglePinnedCollapsed = useCallback(() => {
    const current = sidebarSectionsCollapsedRef.current;
    updateSidebarSectionsCollapsed({ ...current, pinned: !current.pinned });
  }, [updateSidebarSectionsCollapsed]);

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
      if (!diffPanelOpen || diffPanelExpanded) return;
      event.preventDefault();
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
        const localChange = recordLayoutWidthPreferenceChange(startWidth, latestWidth);
        if (localChange) diffPanelWidthChangeRef.current = localChange;
        setDiffPanelResizing(false);
        void persistDiffPanelWidth(latestWidth);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
    },
    [diffPanelExpanded, diffPanelOpen, diffPanelWidth, persistDiffPanelWidth]
  );

  return {
    pinnedCollapsed,
    projectsCollapsed,
    cloudProjectsCollapsed,
    chatsCollapsed,
    sidebarWidth,
    sidebarResizing,
    diffPanelWidth,
    diffPanelResizing,
    togglePinnedCollapsed,
    toggleProjectsCollapsed,
    toggleCloudProjectsCollapsed,
    toggleChatsCollapsed,
    startSidebarResize,
    startDiffPanelResize,
  };
}
