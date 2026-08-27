import { type Dispatch, type SetStateAction } from "react";
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
import {
  modelProjectRoute,
  navigateDesktopRoute,
  modelsSectionFromRoute,
  navigateModelsRoute,
  useModelsRoute,
  type ModelSection,
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

  function clearWorkspaceSelection() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
  }

  function selectModelsSection(section: ModelSection) {
    clearWorkspaceSelection();
    setView("labs");
    navigateModelsRoute(modelProjectRoute(selectedModelProjectId, section));
  }

  function selectModelProject(modelProjectId: string) {
    clearWorkspaceSelection();
    setView("labs");
    navigateModelsRoute(modelProjectRoute(modelProjectId || null));
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
          <label className="sidebar-model-project-picker">
            <span>Model Project</span>
            <select
              aria-label="Select Model Project"
              disabled={!modelProjects.length}
              value={selectedModelProjectId ?? ""}
              onChange={(event) => selectModelProject(event.target.value)}
            >
              <option value="">All Model Projects</option>
              {modelProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <button
            className={`nav-command ${view === "labs" && !selectedModelProjectId ? "active" : ""}`}
            aria-label="Model Projects"
            type="button"
            onClick={() => selectModelsSection("overview")}
          >
            <ChartColumnStacked size={16} />
            <span>Model Projects</span>
          </button>
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
                className={`nav-command ${view === "labs" && activeModelsSection === "versions" ? "active" : ""}`}
                aria-label="Versions"
                type="button"
                onClick={() => selectModelsSection("versions")}
              >
                <CheckCircle2 size={16} />
                <span>Versions</span>
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
