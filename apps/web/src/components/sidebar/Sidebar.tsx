import { Download, PanelLeft } from "../icons";
import { isDesktopShell } from "../app-shell/WindowControls";
import { SidebarNavigation } from "./SidebarNavigation";
import { SidebarSectionList } from "./SidebarSectionList";
import { SidebarBrandButton } from "./SidebarBrandButton";
import type { SidebarProps } from "./Sidebar.types";
import { UserAuthFooter } from "./UserAuthFooter";
import { profileHasUncommittedLocalChanges } from "../../lib/profile-status";
import { useReleaseUpdateCheck } from "../../hooks/useReleaseUpdateCheck";

export function Sidebar(props: SidebarProps) {
  const {
    beginNewChat,
    arch,
    currentVersion,
    onSidebarResizeStart,
    platform,
    setSectionMenuOpen,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setSidebarOpen,
    setSettingsSection,
    setView,
    view,
  } = props;
  const updateCheck = useReleaseUpdateCheck({
    currentVersion,
    platform,
    arch,
    enabled: isDesktopShell(),
  });
  const availableUpdate = updateCheck.status === "available" ? updateCheck.update : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <button className="sidebar-icon" data-tooltip="Hide sidebar" aria-label="Hide sidebar" onClick={() => setSidebarOpen(false)}>
          <PanelLeft size={16} />
        </button>
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

      <div className="sidebar-wordmark-row">
        <SidebarBrandButton onOpenHome={() => beginNewChat(null)} />
      </div>

      <SidebarNavigation
        beginNewChat={beginNewChat}
        setSectionMenuOpen={setSectionMenuOpen}
        setSelectedAppId={setSelectedAppId}
        setSelectedProjectId={setSelectedProjectId}
        setSelectedSessionId={setSelectedSessionId}
        setView={setView}
        profileHasUncommittedChanges={profileHasUncommittedLocalChanges(props.profile)}
        view={view}
      />

      <SidebarSectionList {...props} />

      <UserAuthFooter
        account={props.account}
        onOpenSettings={() => {
          setSectionMenuOpen(null);
          setSettingsSection("account");
          setView("settings");
        }}
      />
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={onSidebarResizeStart}
      />
    </aside>
  );
}

async function openUpdateDownload(url: string): Promise<void> {
  const browser = window.openpond?.browser;
  if (browser?.openExternal) {
    const result = await browser.openExternal({ conversationId: "openpond-update", url });
    if (result.ok) return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
