import { Download, PanelLeft } from "../icons";
import { isDesktopShell } from "../app-shell/WindowControls";
import {
  SidebarNavigation,
  SidebarUtilityNavigation,
} from "./SidebarNavigation";
import { SidebarSectionList } from "./SidebarSectionList";
import { SidebarProductMenu } from "./SidebarProductMenu";
import type { SidebarProps } from "./Sidebar.types";
import { UserAuthFooter } from "./UserAuthFooter";
import { useReleaseUpdateCheck } from "../../hooks/useReleaseUpdateCheck";
import { HarnessLearningSidebarCard } from "./HarnessLearningSidebarCard";

export function Sidebar(props: SidebarProps) {
  const {
    beginNewChat,
    arch,
    currentVersion,
    experience,
    productArea,
    onProductAreaChange,
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
    modelProjects,
    modelTrainingActivityByProjectId,
  } = props;
  const updateCheck = useReleaseUpdateCheck({
    currentVersion,
    platform,
    arch,
    enabled: isDesktopShell(),
  });
  const availableUpdate =
    updateCheck.status === "available" ? updateCheck.update : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <button
          className="sidebar-icon"
          aria-label="Hide sidebar"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeft size={16} />
        </button>
        <SidebarProductMenu
          value={productArea}
          onChange={onProductAreaChange}
        />
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

      <SidebarNavigation
        productArea={productArea}
        experience={experience}
        beginNewChat={beginNewChat}
        setSectionMenuOpen={setSectionMenuOpen}
        setSelectedAppId={setSelectedAppId}
        setSelectedProjectId={setSelectedProjectId}
        setSelectedSessionId={setSelectedSessionId}
        setView={setView}
        view={view}
        modelProjects={modelProjects}
        modelTrainingActivityByProjectId={modelTrainingActivityByProjectId}
      />

      {productArea === "models" ? null : <SidebarSectionList {...props} />}

      <div className="sidebar-bottom-stack">
        {productArea === "models" ? null : (
          <HarnessLearningSidebarCard
            connection={props.connection}
            onOpenSettings={() => {
              setSectionMenuOpen(null);
              setSettingsSection("harness");
              setView("settings");
            }}
          />
        )}
        <div className="sidebar-footer-row">
          <UserAuthFooter
            account={props.account}
            onOpenActivity={() => {
              setSectionMenuOpen(null);
              setSettingsSection("usage");
              setView("settings");
            }}
            onOpenSettings={() => {
              setSectionMenuOpen(null);
              setSettingsSection("account");
              setView("settings");
            }}
          />
          <SidebarUtilityNavigation
            setSectionMenuOpen={setSectionMenuOpen}
            setSelectedAppId={setSelectedAppId}
            setSelectedProjectId={setSelectedProjectId}
            setSelectedSessionId={setSelectedSessionId}
            setView={setView}
            view={view}
          />
        </div>
      </div>
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
    const result = await browser.openExternal({
      conversationId: "openpond-update",
      url,
    });
    if (result.ok) return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
