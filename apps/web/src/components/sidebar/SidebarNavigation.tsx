import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type {
  Experience,
  ModelProject,
  OpenPondApp,
  ProductArea,
} from "@openpond/contracts";
import {
  Boxes,
  CalendarClock,
  ChartColumnStacked,
  Cloud,
  CheckCircle2,
  FileOutput,
  FolderGit2,
  Shapes,
  SquarePen,
} from "../icons";
import { SidebarHelpMenu } from "./SidebarHelpMenu";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type { AppView } from "../../lib/app-models";
import { newExperienceTitle } from "../../lib/experience-options";
import type { LabPrimaryTab } from "../labs/LabsView";
import {
  LAB_PRIMARY_TAB_CHANGE_EVENT,
  LAB_MODEL_PROJECT_CHANGE_EVENT,
  labModelProjectIdFromSearch,
  labPrimaryTabFromSearch,
  searchWithLabModelProject,
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
  modelProjects?: ModelProject[];
  modelTrainingActivityByProjectId?: Record<
    string,
    { label: string; status: string }
  >;
};

export function SidebarNavigation({
  experience = "work",
  productArea = "chat",
  beginNewChat,
  setSectionMenuOpen,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setView,
  view,
  modelProjects = [],
  modelTrainingActivityByProjectId = {},
}: SidebarDestinationProps & {
  beginNewChat: (app?: OpenPondApp | null) => void;
}) {
  const [activeModelsTab, setActiveModelsTab] = useState<LabPrimaryTab>(() =>
    typeof window === "undefined"
      ? "overview"
      : labPrimaryTabFromSearch(window.location.search),
  );
  const [selectedModelProjectId, setSelectedModelProjectId] = useState<string | null>(
    () => typeof window === "undefined" ? null : labModelProjectIdFromSearch(window.location.search),
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

  useEffect(() => {
    const syncModelProject = () =>
      setSelectedModelProjectId(labModelProjectIdFromSearch(window.location.search));
    window.addEventListener("popstate", syncModelProject);
    window.addEventListener(LAB_MODEL_PROJECT_CHANGE_EVENT, syncModelProject);
    return () => {
      window.removeEventListener("popstate", syncModelProject);
      window.removeEventListener(LAB_MODEL_PROJECT_CHANGE_EVENT, syncModelProject);
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

  function selectModelProject(modelProjectId: string) {
    const search = searchWithLabModelProject(window.location.search, modelProjectId || null);
    window.history.pushState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    window.dispatchEvent(new Event(LAB_MODEL_PROJECT_CHANGE_EVENT));
  }

  const selectedTrainingActivity = selectedModelProjectId
    ? modelTrainingActivityByProjectId[selectedModelProjectId] ?? null
    : null;

  return (
    <nav className="sidebar-nav" aria-label="Primary">
      {productArea === "models" ? null : (
        <button
          className="nav-command nav-command-new-task"
          type="button"
          onClick={() => beginNewChat(null)}
        >
          <SquarePen size={18} />
          <span>{newExperienceTitle(experience)}</span>
        </button>
      )}
      {productArea === "models" ? (
        <>
          <label className="sidebar-model-project-picker">
            <span>Model Project</span>
            <select
              aria-label="Select Model Project"
              disabled={!modelProjects.length}
              value={selectedModelProjectId ?? ""}
              onChange={(event) => selectModelProject(event.target.value)}
            >
              {!modelProjects.length ? <option value="">No Model Projects</option> : null}
              {modelProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <button
            className={`nav-command ${view === "labs" && activeModelsTab === "overview" ? "active" : ""}`}
            aria-label="Overview"
            type="button"
            onClick={() => selectModelsTab("overview")}
          >
            <ChartColumnStacked size={16} />
            <span>Overview</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeModelsTab === "tasksets" ? "active" : ""}`}
            aria-label="Taskset"
            type="button"
            onClick={() => selectModelsTab("tasksets")}
          >
            <Boxes size={16} />
            <span>Taskset</span>
          </button>
          <button
            className={`nav-command ${selectedTrainingActivity ? "nav-command-training-live " : ""}${view === "labs" && activeModelsTab === "training" ? "active" : ""}`}
            aria-label={selectedTrainingActivity
              ? `Training, ${selectedTrainingActivity.label}`
              : "Training"}
            type="button"
            onClick={() => selectModelsTab("training")}
          >
            <ChartColumnStacked size={16} />
            <span>Training</span>
            {selectedTrainingActivity ? (
              <span
                className="nav-command-training-status"
                title={`Training ${selectedTrainingActivity.label.toLowerCase()}`}
              >
                <span className="sidebar-running-dot" aria-hidden="true" />
                <span>{selectedTrainingActivity.label}</span>
              </span>
            ) : null}
          </button>
          <button
            className={`nav-command ${view === "labs" && activeModelsTab === "evals" ? "active" : ""}`}
            aria-label="Evals"
            type="button"
            onClick={() => selectModelsTab("evals")}
          >
            <CheckCircle2 size={16} />
            <span>Evals</span>
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
        </>
      ) : null}
      {productArea === "chat" ? (
        <>
          <button
            className={`nav-command nav-command-prominent ${view === "scheduled" ? "active" : ""}`}
            aria-label="Workflows"
            type="button"
            onClick={() => {
              clearWorkspaceSelection();
              setView("scheduled");
            }}
          >
            <CalendarClock size={18} />
            <span>Workflows</span>
          </button>
          <button
            className={`nav-command nav-command-prominent ${view === "outputs" ? "active" : ""}`}
            aria-label="Outputs"
            type="button"
            onClick={() => {
              clearWorkspaceSelection();
              setView("outputs");
            }}
          >
            <FileOutput size={18} />
            <span>Outputs</span>
          </button>
          <button
            className={`nav-command nav-command-prominent ${view === "apps" ? "active" : ""}`}
            aria-label="Apps"
            type="button"
            onClick={() => {
              clearWorkspaceSelection();
              setView("apps");
            }}
          >
            <Shapes size={18} />
            <span>Apps</span>
          </button>
          <button
            className={`nav-command nav-command-prominent ${view === "projects" ? "active" : ""}`}
            aria-label="Projects"
            type="button"
            onClick={() => {
              clearWorkspaceSelection();
              setView("projects");
            }}
          >
            <FolderGit2 size={18} />
            <span>Projects</span>
          </button>
        </>
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
  function selectWalkthroughs() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
    setView("get-started");
  }

  return (
    <nav className="sidebar-utility-nav" aria-label="Resources">
      <SidebarHelpMenu
        onOpenWalkthroughs={selectWalkthroughs}
        walkthroughsActive={view === "get-started"}
      />
    </nav>
  );
}
