import { useState } from "react";
import { Home, PanelsTopLeft } from "lucide-react";
import { CalendarClock, FileOutput, FolderGit2, Globe2, MessageSquare, Shapes } from "../icons";
import type { SidebarProps } from "./Sidebar.types";
import { UserAuthFooter } from "./UserAuthFooter";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import type { AppView } from "../../lib/app-models";
import "../../styles/sidebar/desktop-navigation.css";

export function DesktopNavigationRail({ sidebar, open }: { sidebar: SidebarProps; open: boolean }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const destinations = [
    { view: "chat", label: "Home", Icon: Home },
    { view: "scheduled", label: "Workflows", Icon: CalendarClock },
    { view: "outputs", label: "Outputs", Icon: FileOutput },
    { view: "apps", label: "Apps", Icon: Shapes },
    { view: "projects", label: "Projects", Icon: FolderGit2 },
  ] as const;

  async function select(view: AppView) {
    setAccountOpen(false);
    if (sidebar.productArea === "chat" && sidebar.view === view) {
      if (view === "chat") sidebar.setSidebarOpen(!open);
      return;
    }
    const route = view === "chat" ? { kind: "chat" as const, sessionId: sidebar.selectedSessionId }
      : { kind: "view" as const, view: view as "apps" | "outputs" | "projects" | "scheduled" };
    if (!await navigateDesktopRoute(route)) return;
    sidebar.setSectionMenuOpen(null);
    sidebar.setView(view);
    if (view === "chat") sidebar.setSidebarOpen(true);
  }

  async function selectWalkthroughs() {
    if (!await navigateDesktopRoute({ kind: "view", view: "get-started" })) return;
    sidebar.setSelectedAppId(null);
    sidebar.setSelectedProjectId(null);
    sidebar.setSelectedSessionId(null);
    sidebar.setSectionMenuOpen(null);
    sidebar.setView("get-started");
  }

  return <nav className="desktop-navigation-rail" aria-label="Desktop destinations">
    <div className="desktop-rail-destinations">
      <button type="button" data-rail-tooltip="Training" aria-label="Training"
        className={`desktop-rail-button desktop-training-entry${sidebar.productArea === "console" ? " active" : ""}`}
        aria-expanded={sidebar.productArea === "console" && open} onClick={() => {
          if (sidebar.productArea === "console") sidebar.setSidebarOpen(!open);
          else { sidebar.onProductAreaChange("console"); sidebar.setSidebarOpen(true); }
        }}><PanelsTopLeft size={19} /></button>
      {destinations.map(({ view, label, Icon }) => {
        const active = sidebar.productArea === "chat" && sidebar.view === view;
        return <button key={view} type="button" data-rail-tooltip={label} aria-label={label}
          aria-current={active ? "page" : undefined} aria-expanded={view === "chat" ? active && open : undefined}
          className={`desktop-rail-button${active ? " active" : ""}`}
          onClick={() => void select(view)}><Icon size={19} /></button>;
      })}
      {([{ view: "team", label: "Team chat", Icon: MessageSquare, onOpen: sidebar.onOpenTeamChat },
        { view: "community", label: "Discover communities", Icon: Globe2, onOpen: sidebar.discoverCommunities }] as const).map(({ view, label, Icon, onOpen }) =>
        <button key={view} type="button" data-rail-tooltip={label} aria-label={label}
          className={`desktop-rail-button${sidebar.productArea === "chat" && sidebar.view === view ? " active" : ""}`}
          aria-current={sidebar.productArea === "chat" && sidebar.view === view ? "page" : undefined}
          onClick={() => {
            setAccountOpen(false);
            if (sidebar.productArea !== "chat" || sidebar.view !== view) onOpen();
          }}><Icon size={19} /></button>)}
    </div>
    <div className="desktop-rail-account">
      <UserAuthFooter account={sidebar.account} open={accountOpen} onOpenChange={setAccountOpen}
        hasRunningWork={sidebar.runningSessionIds.size > 0 || Object.values(sidebar.terminalSummaries).some(summary => summary.tabCount > 0)}
        connection={sidebar.connection} onOpenProviders={() => void navigateDesktopRoute({ kind: "settings", section: "providers" })}
        railTooltip={accountOpen ? undefined : "Account"}
        organizations={sidebar.organizations} selectedTeamId={sidebar.selectedTeamId}
        onSelectTeam={sidebar.onSelectTeam} onLogOut={sidebar.onLogOut}
        walkthroughsActive={sidebar.view === "get-started"}
        onOpenWalkthroughs={() => void selectWalkthroughs()}
        onOpenActivity={() => void navigateDesktopRoute({ kind: "settings", section: "usage" })}
        onOpenSettings={() => void navigateDesktopRoute({ kind: "settings", section: "account" })} />
    </div>
  </nav>;
}
