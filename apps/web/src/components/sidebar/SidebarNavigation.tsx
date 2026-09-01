import { type Dispatch, type SetStateAction } from "react";
import type {
  Experience,
  ModelProject,
  OpenPondApp,
  ProductArea,
} from "@openpond/contracts";
import {
  Activity,
  Boxes,
  CalendarClock,
  ChartColumnStacked,
  Cloud,
  CheckCircle2,
  FileOutput,
  FolderGit2,
  GitBranch,
  Shield,
  Shapes,
  SquarePen,
  UserRound,
} from "../icons";
import { SidebarHelpMenu } from "./SidebarHelpMenu";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type { AppView } from "../../lib/app-models";
import { newExperienceTitle } from "../../lib/experience-options";
import {
  modelProjectRoute,
  modelLibraryRoute,
  navigateDesktopRoute,
  modelsLibrarySectionFromRoute,
  modelsSectionFromRoute,
  navigateModelsRoute,
  useModelsRoute,
  type ModelSection,
  type ModelLibrarySection,
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
  const modelsRoute = useModelsRoute();
  const selectedModelProjectId =
    modelsRoute?.kind === "project" ? modelsRoute.projectId : null;
  const activeModelsSection = modelsSectionFromRoute(
    modelsRoute ?? { kind: "index" },
  );
  const activeLibrarySection = modelsLibrarySectionFromRoute(
    modelsRoute ?? { kind: "index" },
  );

  function clearWorkspaceSelection() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
  }

  function selectModelsSection(section: ModelSection) {
    if (!selectedModelProjectId) return;
    clearWorkspaceSelection();
    setView("labs");
    navigateModelsRoute(modelProjectRoute(selectedModelProjectId, section));
  }

  function selectModelsLibrary(section: ModelLibrarySection) {
    clearWorkspaceSelection();
    setView("labs");
    navigateModelsRoute(modelLibraryRoute(section));
  }

  function selectModelsIndex() {
    clearWorkspaceSelection();
    setView("labs");
    navigateModelsRoute({ kind: "index" });
  }

  function selectModelProject(modelProjectId: string) {
    clearWorkspaceSelection();
    setView("labs");
    navigateModelsRoute(modelProjectRoute(modelProjectId || null));
  }

  function selectDesktopView(
    nextView: "apps" | "outputs" | "projects" | "scheduled",
  ) {
    clearWorkspaceSelection();
    setView(nextView);
    navigateDesktopRoute({ kind: "view", view: nextView });
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
          onClick={() => {
            navigateDesktopRoute({ kind: "chat", sessionId: null });
            beginNewChat(null);
          }}
        >
          <SquarePen size={18} />
          <span>{newExperienceTitle(experience)}</span>
        </button>
      )}
      {productArea === "models" ? (
        <>
          <span className="sidebar-nav-group-label">Library</span>
          <button
            className={`nav-command ${view === "labs" && modelsRoute?.kind === "index" ? "active" : ""}`}
            aria-label="Models Overview"
            type="button"
            onClick={selectModelsIndex}
          >
            <Activity size={16} />
            <span>Overview</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeLibrarySection === "projects" ? "active" : ""}`}
            aria-label="Model Projects"
            type="button"
            onClick={() => selectModelsLibrary("projects")}
          >
            <FolderGit2 size={16} />
            <span>Model Projects</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeLibrarySection === "tasksets" ? "active" : ""}`}
            aria-label="Taskset Library"
            type="button"
            onClick={() => selectModelsLibrary("tasksets")}
          >
            <Boxes size={16} />
            <span>Taskset Library</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeLibrarySection === "scorers" ? "active" : ""}`}
            aria-label="Scorers"
            type="button"
            onClick={() => selectModelsLibrary("scorers")}
          >
            <Shield size={16} />
            <span>Scorers</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeLibrarySection === "evaluations" ? "active" : ""}`}
            aria-label="Evaluations"
            type="button"
            onClick={() => selectModelsLibrary("evaluations")}
          >
            <CheckCircle2 size={16} />
            <span>Evaluations</span>
          </button>
          <button
            className={`nav-command ${view === "labs" && activeLibrarySection === "reviews" ? "active" : ""}`}
            aria-label="Human Review"
            type="button"
            onClick={() => selectModelsLibrary("reviews")}
          >
            <UserRound size={16} />
            <span>Human Review</span>
          </button>
          <span className="sidebar-nav-group-label">Current project</span>
          <div className="sidebar-model-project-picker">
            <select
              aria-label="Select Model Project"
              disabled={!modelProjects.length}
              value={selectedModelProjectId ?? ""}
              onChange={(event) => selectModelProject(event.target.value)}
            >
              <option disabled value="">Select a Model Project</option>
              {modelProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>
          {selectedModelProjectId ? (
            <>
              <button
                className={`nav-command ${view === "labs" && activeModelsSection === "overview" ? "active" : ""}`}
                aria-label="Overview"
                type="button"
                onClick={() => selectModelsSection("overview")}
              >
                <ChartColumnStacked size={16} />
                <span>Overview</span>
              </button>
              <button
                className={`nav-command ${view === "labs" && activeModelsSection === "tasksets" ? "active" : ""}`}
                aria-label="Tasksets"
                type="button"
                onClick={() => selectModelsSection("tasksets")}
              >
                <Boxes size={16} />
                <span>Tasksets</span>
              </button>
              <button
                className={`nav-command ${view === "labs" && activeModelsSection === "evals" ? "active" : ""}`}
                aria-label="Evals"
                type="button"
                onClick={() => selectModelsSection("evals")}
              >
                <CheckCircle2 size={16} />
                <span>Evaluations</span>
              </button>
              <button
                className={`nav-command ${selectedTrainingActivity ? "nav-command-training-live " : ""}${view === "labs" && activeModelsSection === "runs" ? "active" : ""}`}
                aria-label={selectedTrainingActivity
                  ? `Runs, ${selectedTrainingActivity.label}`
                  : "Runs"}
                type="button"
                onClick={() => selectModelsSection("runs")}
              >
                <ChartColumnStacked size={16} />
                <span>Runs</span>
                {selectedTrainingActivity ? (
                  <span
                    className="nav-command-training-status"
                    aria-label={`Training ${selectedTrainingActivity.label.toLowerCase()}`}
                    title={`Training ${selectedTrainingActivity.label.toLowerCase()}`}
                  >
                    <span className="sidebar-running-dot" aria-hidden="true" />
                  </span>
                ) : null}
              </button>
              <button
                className={`nav-command ${view === "labs" && activeModelsSection === "versions" ? "active" : ""}`}
                aria-label="Versions"
                type="button"
                onClick={() => selectModelsSection("versions")}
              >
                <GitBranch size={16} />
                <span>Versions</span>
              </button>
              <button
                className={`nav-command ${view === "labs" && activeModelsSection === "serving" ? "active" : ""}`}
                aria-label="Serving"
                type="button"
                onClick={() => selectModelsSection("serving")}
              >
                <Cloud size={16} />
                <span>Serving</span>
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {productArea === "chat" ? (
        <>
          <button
            className={`nav-command nav-command-prominent ${view === "scheduled" ? "active" : ""}`}
            aria-label="Workflows"
            type="button"
            onClick={() => {
              selectDesktopView("scheduled");
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
              selectDesktopView("outputs");
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
              selectDesktopView("apps");
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
              selectDesktopView("projects");
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
    navigateDesktopRoute({ kind: "view", view: "get-started" });
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
