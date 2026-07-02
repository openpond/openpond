import { useCallback, useEffect, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { normalizePreferences } from "../lib/app-models";
import { DEFAULT_DIFF_PANEL_WIDTH, DEFAULT_SIDEBAR_WIDTH, clampDiffPanelWidth, clampSidebarWidth } from "../lib/layout";

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
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [cloudProjectsCollapsed, setCloudProjectsCollapsed] = useState(false);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [diffPanelWidth, setDiffPanelWidth] = useState(DEFAULT_DIFF_PANEL_WIDTH);
  const [diffPanelResizing, setDiffPanelResizing] = useState(false);

  useEffect(() => {
    if (sidebarResizing) return;
    setSidebarWidth(clampSidebarWidth(normalizePreferences(preferences).sidebarWidth));
  }, [preferences, sidebarResizing]);

  useEffect(() => {
    if (diffPanelResizing) return;
    setDiffPanelWidth(clampDiffPanelWidth(normalizePreferences(preferences).diffPanelWidth));
  }, [diffPanelResizing, preferences]);

  useEffect(() => {
    const normalized = normalizePreferences(preferences);
    setPinnedCollapsed(normalized.sidebarSectionsCollapsed.pinned);
    setProjectsCollapsed(normalized.sidebarSectionsCollapsed.projects);
    setCloudProjectsCollapsed(normalized.sidebarSectionsCollapsed.cloudProjects);
    setChatsCollapsed(normalized.sidebarSectionsCollapsed.chats);
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

  const togglePinnedCollapsed = useCallback(() => {
    const pinned = !pinnedCollapsed;
    setPinnedCollapsed(pinned);
    void persistSidebarSectionsCollapsed({
      pinned,
      projects: projectsCollapsed,
      cloudProjects: cloudProjectsCollapsed,
      chats: chatsCollapsed,
    });
  }, [chatsCollapsed, cloudProjectsCollapsed, persistSidebarSectionsCollapsed, pinnedCollapsed, projectsCollapsed]);

  const toggleProjectsCollapsed = useCallback(() => {
    const projects = !projectsCollapsed;
    setProjectsCollapsed(projects);
    void persistSidebarSectionsCollapsed({
      pinned: pinnedCollapsed,
      projects,
      cloudProjects: cloudProjectsCollapsed,
      chats: chatsCollapsed,
    });
  }, [chatsCollapsed, cloudProjectsCollapsed, persistSidebarSectionsCollapsed, pinnedCollapsed, projectsCollapsed]);

  const toggleCloudProjectsCollapsed = useCallback(() => {
    const cloudProjects = !cloudProjectsCollapsed;
    setCloudProjectsCollapsed(cloudProjects);
    void persistSidebarSectionsCollapsed({
      pinned: pinnedCollapsed,
      projects: projectsCollapsed,
      cloudProjects,
      chats: chatsCollapsed,
    });
  }, [chatsCollapsed, cloudProjectsCollapsed, persistSidebarSectionsCollapsed, pinnedCollapsed, projectsCollapsed]);

  const toggleChatsCollapsed = useCallback(() => {
    const chats = !chatsCollapsed;
    setChatsCollapsed(chats);
    void persistSidebarSectionsCollapsed({
      pinned: pinnedCollapsed,
      projects: projectsCollapsed,
      cloudProjects: cloudProjectsCollapsed,
      chats,
    });
  }, [chatsCollapsed, cloudProjectsCollapsed, persistSidebarSectionsCollapsed, pinnedCollapsed, projectsCollapsed]);

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
        void persistSidebarWidth(latestWidth).finally(() => setSidebarResizing(false));
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
        void persistDiffPanelWidth(latestWidth).finally(() => setDiffPanelResizing(false));
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
