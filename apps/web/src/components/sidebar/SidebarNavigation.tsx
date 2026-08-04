import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type {
  Experience,
  OpenPondApp,
  ProductArea,
} from "@openpond/contracts";
import {
  Activity,
  BookOpenText,
  Boxes,
  ChartColumnStacked,
  Cloud,
  Plug,
  SquarePen,
  UserRound,
} from "../icons";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type { AppView } from "../../lib/app-models";
import { newExperienceTitle } from "../../lib/experience-options";
import type { LabPrimaryTab } from "../labs/LabsView";
import {
  LAB_PRIMARY_TAB_CHANGE_EVENT,
  labPrimaryTabFromSearch,
  searchWithLabPrimaryTab,
} from "../labs/lab-primary-tab-state";

type SidebarDestinationProps = {
  experience?: Experience;
  productArea?: ProductArea;
  setSectionMenuOpen: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setView: Dispatch<SetStateAction<AppView>>;
  view: AppView;
};

export function SidebarNavigation({
  experience = "development",
  productArea = "development",
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
  const [activeModelsTab, setActiveModelsTab] = useState<LabPrimaryTab>(() =>
    typeof window === "undefined"
      ? "models"
      : labPrimaryTabFromSearch(window.location.search),
  );

  useEffect(() => {
    const syncModelsTab = () =>
      setActiveModelsTab(labPrimaryTabFromSearch(window.location.search));
    window.addEventListener("popstate", syncModelsTab);
    window.addEventListener(LAB_PRIMARY_TAB_CHANGE_EVENT, syncModelsTab);
    return () => {
      window.removeEventListener("popstate", syncModelsTab);
      window.removeEventListener(LAB_PRIMARY_TAB_CHANGE_EVENT, syncModelsTab);
    };
  }, []);

  function clearWorkspaceSelection() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
  }

  function selectModelsTab(tab: LabPrimaryTab) {
    clearWorkspaceSelection();
    setView("labs");
    setActiveModelsTab(tab);
    const search = searchWithLabPrimaryTab(window.location.search, tab);
    window.history.pushState(
      window.history.state,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
    window.dispatchEvent(new Event(LAB_PRIMARY_TAB_CHANGE_EVENT));
  }

  return (
    <nav className="sidebar-nav" aria-label="Primary">
      {productArea === "models" ? null : (
        <button
          className="nav-command"
          type="button"
          onClick={() => beginNewChat(null)}
        >
          <SquarePen size={16} />
          <span>{newExperienceTitle(experience)}</span>
        </button>
      )}
      {productArea === "models" ? (
        <>
          <button
            className={`nav-command ${view === "labs" && activeModelsTab === "models" ? "active" : ""}`}
            aria-label="Models"
            type="button"
            onClick={() => selectModelsTab("models")}
          >
            <ChartColumnStacked size={16} />
            <span>Models</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeModelsTab === "tasksets" ? "active" : ""}`}
            aria-label="Tasksets"
            type="button"
            onClick={() => selectModelsTab("tasksets")}
          >
            <Boxes size={16} />
            <span>Tasksets</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeModelsTab === "serving" ? "active" : ""}`}
            aria-label="Serving"
            type="button"
            onClick={() => selectModelsTab("serving")}
          >
            <Cloud size={16} />
            <span>Serving</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeModelsTab === "usage" ? "active" : ""}`}
            aria-label="Usage"
            type="button"
            onClick={() => selectModelsTab("usage")}
          >
            <Activity size={16} />
            <span>Usage</span>
          </button>
        </>
      ) : null}
      {productArea === "development" ? (
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
        </>
      ) : null}
      {productArea === "development" ? (
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
