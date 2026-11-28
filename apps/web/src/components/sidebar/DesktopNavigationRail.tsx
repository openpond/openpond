import { useId, useRef, useState } from "react";
import { CircleAlert, Home, LayoutDashboard, MessageCircle, type LucideIcon } from "lucide-react";
import { useConnectionStatus } from "../../hooks/useConnectionStatus";
import { CalendarClock, FileOutput, FolderGit2, Globe2, MessageSquare, MoreHorizontal, Shapes } from "../icons";
import type { SidebarProps } from "./Sidebar.types";
import { UserAuthFooter } from "./UserAuthFooter";
import { modelsLocation, navigateDesktopRoute, navigateModelsRoute, useModelsRoute } from "../labs/lab-primary-tab-state";
import type { ChatProvider } from "@openpond/contracts";
import { PlanUsageControl } from "./PlanUsageControl";
import "../../styles/sidebar/desktop-navigation.css";

const resourceDestinations = [
  { page: "home", label: "Overview", icon: null },
  { page: "models", label: "Models", icon: "model-registry" },
  { page: "experiments", label: "Benchmarks", icon: "evaluations" },
  { page: "datasets", label: "Datasets", icon: "tasksets" },
  { page: "graders", label: "Graders", icon: "graders" },
  { page: "serving", label: "Serving", icon: "model-serving" },
] as const;
type ResourcePage = (typeof resourceDestinations)[number]["page"];
type MoreDestination = { view: "scheduled" | "outputs" | "apps" | "projects" | "chat" | "community" | "team"; label: string; Icon: LucideIcon };
const moreDestinations = [
  { view: "scheduled", label: "Workflows", Icon: CalendarClock },
  { view: "outputs", label: "Outputs", Icon: FileOutput },
  { view: "apps", label: "Apps", Icon: Shapes },
  { view: "projects", label: "Projects", Icon: FolderGit2 },
  { view: "chat", label: "Chat", Icon: MessageCircle },
  { view: "community", label: "Discover", Icon: Globe2 },
] as const satisfies readonly MoreDestination[];
const teamDestination = { view: "team", label: "Team chat", Icon: MessageSquare } as const satisfies MoreDestination;

export function DesktopNavigationRail({ sidebar, open, provider }: { sidebar: SidebarProps; open: boolean; provider: ChatProvider }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const connectionStatus = useConnectionStatus(sidebar.connection);
  const modelsRoute = useModelsRoute();
  const moreId = useId();
  const morePopover = useRef<HTMLDivElement>(null);
  const destinations = sidebar.teamChatEnabled ? [...moreDestinations, teamDestination] : moreDestinations;
  const activeView = sidebar.productArea === "chat" ? sidebar.view : null;

  async function selectResource(page: ResourcePage) {
    setAccountOpen(false);
    morePopover.current?.hidePopover();
    const route = page === "models" ? modelsLocation() : modelsLocation(page, null, { area: "console" });
    if (!await navigateModelsRoute(route)) return;
    sidebar.setSectionMenuOpen(null);
    sidebar.setView("labs");
    sidebar.setSidebarOpen(true);
  }

  async function selectMore(view: MoreDestination["view"]) {
    setAccountOpen(false);
    morePopover.current?.hidePopover();
    if (view === "team") { sidebar.onOpenTeamChat(); return; }
    if (view === "community") { sidebar.discoverCommunities(); return; }
    if (activeView === view) {
      if (view === "chat" && !open) sidebar.setSidebarOpen(true);
      return;
    }
    const route = view === "chat" ? { kind: "chat" as const, sessionId: sidebar.selectedSessionId }
      : { kind: "view" as const, view };
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

  async function openHome() {
    if (!await navigateDesktopRoute({ kind: "chat", sessionId: null })) return;
    setAccountOpen(false);
    morePopover.current?.hidePopover();
    sidebar.setSectionMenuOpen(null);
    sidebar.openHomeChat();
    sidebar.setSidebarOpen(true);
  }

  return <nav className="desktop-navigation-rail" aria-label="Desktop destinations">
    <button type="button" className="desktop-rail-destination" aria-label="Home" data-rail-tooltip="New chat"
      aria-current={activeView === "chat" && !sidebar.selectedSessionId ? "page" : undefined}
      onClick={() => void openHome()}><span className="desktop-rail-destination-icon"><Home size={21} aria-hidden /></span><span>Home</span></button>
    <div className="desktop-rail-destinations">
      {resourceDestinations.map(({ page, label, icon }) => {
        const active = sidebar.view === "labs" && (modelsRoute?.page === page ||
          page === "models" && (["runs", "versions", "evaluations", "tasks"].includes(modelsRoute?.page ?? "") ||
            modelsRoute?.page === "tasksets" && Boolean(modelsRoute.modelId)) ||
          page === "datasets" && modelsRoute?.page === "tasksets" && !modelsRoute.modelId);
        return <button key={page} type="button" className="desktop-rail-destination" aria-label={label}
          aria-current={active ? "page" : undefined} onClick={() => void selectResource(page)}>
          <span className="desktop-rail-destination-icon">
            {icon ? <span aria-hidden className="desktop-rail-resource-icon" style={{ maskImage: `url("/console-icons/${icon}.svg")` }} /> : <LayoutDashboard size={21} aria-hidden />}
          </span>
          <span>{label}</span>
        </button>;
      })}
      <button type="button" className="desktop-rail-destination desktop-rail-more-trigger" aria-label="More"
        data-active={destinations.some(({ view }) => view === activeView) || undefined}
        popoverTarget={moreId} onClick={() => setAccountOpen(false)}>
        <span className="desktop-rail-destination-icon"><MoreHorizontal size={21} aria-hidden /></span>
        <span>More</span>
      </button>
    </div>
    <div id={moreId} ref={morePopover} className="desktop-rail-more" popover="auto" role="group" aria-label="More destinations">
      {destinations.map(({ view, label, Icon }) => <button type="button" key={view} aria-label={label}
        aria-current={activeView === view ? "page" : undefined} onClick={() => void selectMore(view)}>
        <Icon size={16} aria-hidden /><span>{label}</span>
      </button>)}
    </div>
    <div className="desktop-rail-account">
      {connectionStatus.error ? <button type="button" className="desktop-rail-button desktop-connection-error"
        aria-label="OpenPond connection interrupted" aria-description={`${connectionStatus.error} Retrying every 5 seconds.`}
        data-rail-tooltip={`${connectionStatus.error} Retrying every 5 seconds.`}
        onClick={() => void navigateDesktopRoute({ kind: "settings", section: "diagnostics" })}>
        <CircleAlert size={18} />
      </button> : null}
      <PlanUsageControl connection={sidebar.connection} provider={sidebar.productArea === "chat" && sidebar.view === "chat" ? provider : null} accountOpen={accountOpen}
        onOpen={() => setAccountOpen(false)} onOpenProviders={() => void navigateDesktopRoute({ kind: "settings", section: "providers" })} />
      <UserAuthFooter account={sidebar.account} open={accountOpen} onOpenChange={setAccountOpen}
        hasRunningWork={sidebar.runningSessionIds.size > 0 || Object.values(sidebar.terminalSummaries).some(summary => summary.tabCount > 0)}
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
