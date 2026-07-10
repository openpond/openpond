import type { Dispatch, SetStateAction } from "react";
import type { OpenPondApp } from "@openpond/contracts";
import { BookOpenText, Bot, Lightbulb, Plug, SquarePen } from "../icons";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type { AppView } from "../../lib/app-models";

export function SidebarNavigation({
  beginNewChat,
  profileHasUncommittedChanges,
  setSectionMenuOpen,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setView,
  view,
}: {
  beginNewChat: (app?: OpenPondApp | null) => void;
  profileHasUncommittedChanges: boolean;
  setSectionMenuOpen: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
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
        className={`nav-command nav-profile-command ${view === "profile" ? "active" : ""}`}
        aria-label="Agents"
        onClick={() => {
          clearWorkspaceSelection();
          setView("profile");
        }}
      >
        <Bot size={16} />
        <span className="nav-profile-label">
          <span>Agents</span>
          {profileHasUncommittedChanges ? (
            <span
              className="sidebar-profile-change-dot"
              data-tooltip="Local profile changes are not committed"
              aria-hidden="true"
            />
          ) : null}
        </span>
      </button>
      <button
        className={`nav-command ${view === "insights" ? "active" : ""}`}
        onClick={() => {
          clearWorkspaceSelection();
          setView("insights");
        }}
        type="button"
      >
        <Lightbulb size={16} />
        <span>Insights</span>
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
