import type { Dispatch, SetStateAction } from "react";
import type { OpenPondApp } from "@openpond/contracts";
import { BookOpenText, Duck, Plug, SquarePen } from "../icons";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type { AppView, LabsTab } from "../../lib/app-models";

export function SidebarNavigation({
  beginNewChat,
  setSectionMenuOpen,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setLabsTab,
  setView,
  view,
}: {
  beginNewChat: (app?: OpenPondApp | null) => void;
  setSectionMenuOpen: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setLabsTab: Dispatch<SetStateAction<LabsTab>>;
  setView: Dispatch<SetStateAction<AppView>>;
  view: AppView;
}) {
  function clearWorkspaceSelection() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
  }

  return (
    <nav className="sidebar-nav" aria-label="Primary">
      <button className="nav-command" onClick={() => beginNewChat(null)}>
        <SquarePen size={16} />
        <span>New task</span>
      </button>
      <button
        className={`nav-command ${view === "get-started" ? "active" : ""}`}
        onClick={() => {
          clearWorkspaceSelection();
          setView("get-started");
        }}
        type="button"
      >
        <BookOpenText size={16} />
        <span>Get started</span>
      </button>
      <button
        className={`nav-command nav-profile-command ${view === "labs" ? "active" : ""}`}
        aria-label="Lab"
        onClick={() => {
          clearWorkspaceSelection();
          setLabsTab("profile");
          setView("labs");
        }}
      >
        <Duck size={16} />
        <span>Lab</span>
      </button>
      <button
        className={`nav-command ${view === "apps" ? "active" : ""}`}
        onClick={() => {
          setView("apps");
          clearWorkspaceSelection();
        }}
      >
        <Plug size={16} />
        <span>Apps</span>
      </button>
    </nav>
  );
}
