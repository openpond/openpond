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
} from "../icons";
import { DropdownSelect } from "../DropdownSelect";
import { SidebarHelpMenu } from "./SidebarHelpMenu";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type { AppView } from "../../lib/app-models";
import { newExperienceTitle } from "../../lib/experience-options";
import {
  changeModelsScope,
  modelsLocation,
  MODELS_PAGES,
  MODELS_PAGE_LABELS,
  navigateDesktopRoute,
  navigateModelsRoute,
  useModelsRoute,
  type ModelsPage,
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
  const selectedModelProjectId = modelsRoute?.modelId ?? null;
  const activePage = modelsRoute?.page ?? "models";

  function clearWorkspaceSelection() {
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSectionMenuOpen(null);
  }

  async function selectModelsPage(page: ModelsPage) {
    if (!await navigateModelsRoute(modelsLocation(page, selectedModelProjectId))) return;
    clearWorkspaceSelection();
    setView("labs");
  }

  async function selectModelProject(modelId: string) {
    if (!await navigateModelsRoute(changeModelsScope(modelsRoute ?? modelsLocation(), modelId || null))) return;
    clearWorkspaceSelection();
    setView("labs");
  }

  async function selectDesktopView(nextView: "apps" | "outputs" | "projects" | "scheduled") {
    if (!await navigateDesktopRoute({ kind: "view", view: nextView })) return;
    clearWorkspaceSelection();
    setView(nextView);
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
          <div className="sidebar-model-project-picker">
            <span className="sidebar-nav-group-label">Model</span>
            <DropdownSelect
              label="Model"
              searchable={modelProjects.length > 8}
              value={selectedModelProjectId ?? ""}
              options={[
                { value: "", label: "All models" },
                ...(selectedModelProjectId && !modelProjects.some((project) => project.id === selectedModelProjectId)
                  ? [{ value: selectedModelProjectId, label: "Unavailable model", disabled: true }]
                  : []),
                ...modelProjects.map((project) => ({ value: project.id, label: project.name })),
              ]}
              onChange={(id) => void selectModelProject(id)}
            />
          </div>
          {MODELS_PAGES.map((page) => {
            const Icon = { models: Activity, tasksets: Boxes, rewards: Shield, evaluations: CheckCircle2, runs: ChartColumnStacked, versions: GitBranch, serving: Cloud }[page];
            return (
              <button
                className={`nav-command ${view === "labs" && activePage === page ? "active" : ""}`}
                aria-current={view === "labs" && activePage === page ? "page" : undefined}
                key={page}
                type="button"
                onClick={() => void selectModelsPage(page)}
              >
                <Icon size={16} />
                <span>{MODELS_PAGE_LABELS[page]}</span>
                {page === "runs" && selectedTrainingActivity ? <span className="sidebar-running-dot" aria-label={selectedTrainingActivity.label} /> : null}
              </button>
            );
          })}
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
