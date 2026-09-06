import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
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
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import type { SidebarSectionMenuId } from "../../app/app-state";

export function Sidebar(props: SidebarProps) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
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
    setView,
    view,
    modelProjects,
    modelTrainingActivityByProjectId,
  } = props;
  const setSidebarSectionMenuOpen = useCallback<
    Dispatch<SetStateAction<SidebarSectionMenuId | null>>
  >(
    (value) => {
      setAccountMenuOpen(false);
      setSectionMenuOpen(value);
    },
    [setSectionMenuOpen],
  );
  const setAccountMenu = useCallback(
    (nextOpen: boolean) => {
      setAccountMenuOpen(nextOpen);
      if (nextOpen) setSectionMenuOpen(null);
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
        setSectionMenuOpen={setSidebarSectionMenuOpen}
        setSelectedAppId={setSelectedAppId}
        setSelectedProjectId={setSelectedProjectId}
        setSelectedSessionId={setSelectedSessionId}
        setView={setView}
        view={view}
        modelProjects={modelProjects}
        modelTrainingActivityByProjectId={modelTrainingActivityByProjectId}
      />

      {productArea === "models" ? null : (
        <SidebarSectionList
          {...props}
          setSectionMenuOpen={setSidebarSectionMenuOpen}
        />
      )}

      <div className="sidebar-bottom-stack">
        {productArea === "models" ? null : (
          <HarnessLearningSidebarCard
            connection={props.connection}
            onOpenSettings={() => {
              setSectionMenuOpen(null);
              void navigateDesktopRoute({ kind: "settings", section: "harness" });
            }}
          />
        )}
        <div className="sidebar-footer-row">
          <UserAuthFooter
            account={props.account}
            open={accountMenuOpen}
            organizations={props.organizations}
            selectedTeamId={props.teamChatOrganization?.teamId ?? null}
            onOpenChange={setAccountMenu}
            onOpenActivity={() => {
              setSectionMenuOpen(null);
              void navigateDesktopRoute({ kind: "settings", section: "usage" });
            }}
            onOpenSettings={() => {
              setSectionMenuOpen(null);
              void navigateDesktopRoute({ kind: "settings", section: "account" });
            }}
            onSelectTeam={props.onSelectTeam}
            onLogOut={props.onLogOut}
          />
          <SidebarUtilityNavigation
            setSectionMenuOpen={setSidebarSectionMenuOpen}
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
