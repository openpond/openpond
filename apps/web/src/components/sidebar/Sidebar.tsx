import { useCallback, type Dispatch, type SetStateAction } from "react";
import { Download, PanelLeft } from "../icons";
import { isDesktopShell } from "../app-shell/WindowControls";
import {
  SidebarNavigation,
  SidebarNewTask,
} from "./SidebarNavigation";
import { SidebarSectionList } from "./SidebarSectionList";
import { NativeConversationControls, useNativeConversationHistory } from "./NativeConversationSources";
import { OPENPOND_ICON_URL, OPENPOND_WORDMARK_WHITE_URL } from "../../lib/public-assets";
import type { SidebarProps } from "./Sidebar.types";
import { useReleaseUpdateCheck } from "../../hooks/useReleaseUpdateCheck";
import { HarnessLearningSidebarCard } from "./HarnessLearningSidebarCard";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import type { SidebarSectionMenuId } from "../../app/app-state";

export function Sidebar(props: SidebarProps & { open?: boolean }) {

  const {
    arch,
    currentVersion,
    productArea,
    platform,
    setSectionMenuOpen,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setSidebarOpen,
    setView,
    view,
    modelProjects,
    modelTrainingActivityByProjectId,
  } = props;
  const setSidebarSectionMenuOpen = useCallback<
    Dispatch<SetStateAction<SidebarSectionMenuId | null>>
  >(
    (value) => {
      setSectionMenuOpen(value);
    },
    [setSectionMenuOpen],
  );
  const updateCheck = useReleaseUpdateCheck({
    currentVersion,
    platform,
    arch,
    enabled: isDesktopShell(),
  });
  const availableUpdate =
    updateCheck.status === "available" ? updateCheck.update : null;

  const selectSession = useCallback(async (session: import("@openpond/contracts").Session) => {
    if (!await navigateDesktopRoute({ kind: "chat", sessionId: session.id })) return false;
    setSelectedSessionId(session.id);
    const projectId = props.sidebarProjectIdBySessionId[session.id] ?? null;
    setSelectedProjectId(projectId); setSelectedAppId(projectId ? null : session.appId);
    setView("chat"); return true;
  }, [setSelectedSessionId, setSelectedProjectId, setSelectedAppId, setView, props.sidebarProjectIdBySessionId]);
  const nativeHistory = useNativeConversationHistory({ connection: productArea === "chat" ? props.connection : null, active: view === "chat", selectedSessionId: props.selectedSessionId, selectedSession: [...props.activeSessions, ...props.archivedSessions, ...Object.values(props.childSessionRowsByParentId ?? {}).flat()].find((session) => session.id === props.selectedSessionId) ?? null, onOpen: selectSession });

  return (
    <aside className="sidebar" inert={props.open === false}>
      <div className="sidebar-toolbar">
        <button
          className="sidebar-icon"
          aria-label="Hide sidebar"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeft size={16} />
        </button>
        <div className="sidebar-brand">
          <img className="sidebar-wordmark" src={OPENPOND_WORDMARK_WHITE_URL} alt="OpenPond" />
        </div>
        {availableUpdate && (
          <button
            type="button"
            className="sidebar-update-pill"
            title={`Download OpenPond ${availableUpdate.version}: ${availableUpdate.assetName}`}
            aria-label={`Download OpenPond ${availableUpdate.version}`}
            onClick={() => void openUpdateDownload(availableUpdate.downloadUrl)}
          >
            <Download size={14} />
            <span>Update</span>
          </button>
        )}
      </div>

      {productArea === "chat" ? <div className="sidebar-fixed-actions">
      <SidebarNewTask experience={props.experience} beginNewChat={props.beginNewChat} />

      {productArea === "chat" && view === "chat" && props.account?.activeProfile && props.onOpenPonder ? (
        <div className="sidebar-ponder-fixed">
          <button type="button" className="sidebar-row sidebar-task-row sidebar-ponder-entry" onClick={props.onOpenPonder}>
            <span className="conversation-source-icon" aria-hidden="true"><img src={OPENPOND_ICON_URL} alt="" /></span>
            <span>Ponder Pal</span>
          </button>
        </div>
      ) : null}
      </div> : null}

      <div className="sidebar-scroll">
        {productArea !== "chat" ? <SidebarNavigation
          productArea={productArea}
          setSectionMenuOpen={setSidebarSectionMenuOpen}
          setSelectedAppId={setSelectedAppId}
          setSelectedProjectId={setSelectedProjectId}
          setSelectedSessionId={setSelectedSessionId}
          setView={setView}
          view={view}
          modelProjects={modelProjects}
          modelTrainingActivityByProjectId={modelTrainingActivityByProjectId}
        /> : null}

        {productArea !== "chat" || view !== "chat" ? null : (
          <SidebarSectionList
            {...props}
            onSelectSession={nativeHistory.select}
            setSectionMenuOpen={setSidebarSectionMenuOpen}
          />
        )}
        {productArea === "chat" && view === "chat" ? <NativeConversationControls history={nativeHistory} /> : null}
      </div>

      <div className="sidebar-bottom-stack">
        {productArea !== "chat" ? null : (
          <HarnessLearningSidebarCard
            connection={props.connection}
            onOpenSettings={() => {
              setSectionMenuOpen(null);
              void navigateDesktopRoute({ kind: "settings", section: "harness" });
            }}
          />
        )}
      </div>
    </aside>
  );
}

async function openUpdateDownload(url: string): Promise<void> {
  const browser = window.openpond?.browser;
  if (browser?.openExternal) {
    const result = await browser.openExternal({
      conversationId: "openpond-update",
      url,
    });
    if (result.ok) return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
