import type { Dispatch, SetStateAction } from "react";
import type { Experience, OpenPondApp } from "@openpond/contracts";
import {
  BookOpenText,
  CalendarClock,
  ChartColumnStacked,
  Plug,
  SquarePen,
  UserRound,
} from "../icons";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type { AppView } from "../../lib/app-models";

type SidebarDestinationProps = {
  experience?: Experience;
  setSectionMenuOpen: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setView: Dispatch<SetStateAction<AppView>>;
  view: AppView;
};

export function SidebarNavigation({
  experience = "development",
  beginNewChat,
  setSectionMenuOpen,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setView,
  view,
}: SidebarDestinationProps & {
  beginNewChat: (app?: OpenPondApp | null) => void;
}) {
  function clearWorkspaceSelection() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
  }

  return (
    <nav className="sidebar-nav" aria-label="Primary">
      <button
        className="nav-command"
        type="button"
        onClick={() => beginNewChat(null)}
      >
        <SquarePen size={16} />
        <span>{experience === "chat" ? "New chat" : "New task"}</span>
      </button>
      {experience === "work" ? (
        <button
          className={`nav-command ${view === "scheduled" ? "active" : ""}`}
          aria-label="Scheduled"
          type="button"
          onClick={() => {
            clearWorkspaceSelection();
            setView("scheduled");
          }}
        >
          <CalendarClock size={16} />
          <span>Scheduled</span>
        </button>
      ) : null}
      {experience === "development" ? (
        <>
          <button
            className={`nav-command ${view === "profile" ? "active" : ""}`}
            aria-label="Profile"
            type="button"
            onClick={() => {
              clearWorkspaceSelection();
              setView("profile");
            }}
          >
            <UserRound size={16} />
            <span>Profile</span>
          </button>
          <button
            className={`nav-command ${view === "labs" ? "active" : ""}`}
            aria-label="Models"
            type="button"
            onClick={() => {
              clearWorkspaceSelection();
              setView("labs");
            }}
          >
            <ChartColumnStacked size={16} />
            <span>Models</span>
          </button>
        </>
      ) : null}
      {experience !== "chat" ? (
        <button
          className={`nav-command ${view === "apps" ? "active" : ""}`}
          onClick={() => {
            clearWorkspaceSelection();
            setView("apps");
          }}
          type="button"
        >
          <Plug size={16} />
          <span>Apps</span>
        </button>
      ) : null}
    </nav>
  );
}

export function SidebarUtilityNavigation({
  setSectionMenuOpen,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setView,
  view,
}: SidebarDestinationProps) {
  function selectDocs() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
    setView("get-started");
  }

  return (
    <nav className="sidebar-utility-nav" aria-label="Resources">
      <button
        className={`sidebar-icon sidebar-docs-button ${
          view === "get-started" ? "active" : ""
        }`}
        data-tooltip="Docs"
        aria-label="Docs"
        onClick={selectDocs}
        type="button"
      >
        <BookOpenText size={17} />
      </button>
    </nav>
  );
}
