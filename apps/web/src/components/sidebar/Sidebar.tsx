import { PanelLeft } from "../icons";
import { SidebarNavigation } from "./SidebarNavigation";
import { SidebarSectionList } from "./SidebarSectionList";
import type { SidebarProps } from "./Sidebar.types";
import { UserAuthFooter } from "./UserAuthFooter";
import { profileHasUncommittedLocalChanges } from "../../lib/profile-status";

export function Sidebar(props: SidebarProps) {
  const {
    beginNewChat,
    onSidebarResizeStart,
    setSectionMenuOpen,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setSidebarOpen,
    setSettingsSection,
    setView,
    view,
  } = props;

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <button className="sidebar-icon" data-tooltip="Hide sidebar" aria-label="Hide sidebar" onClick={() => setSidebarOpen(false)}>
          <PanelLeft size={16} />
        </button>
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
