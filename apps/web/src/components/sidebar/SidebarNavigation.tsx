import type { OpenPondApp } from "@openpond/contracts";
import { SquarePen } from "../icons";
import { BaseModelIcon } from "../labs/BaseModelIcon";
import { SidebarModelControls } from "./SidebarModelResource";
import type { SidebarProps } from "./Sidebar.types";
import {
  modelsLocation,
  modelsPath,
  hasResourceSidebar,
  navigateDesktopRoute,
  navigateModelsRoute,
  useModelsRoute,
  type ModelsRoute,
} from "../labs/lab-primary-tab-state";

export function SidebarNewThreadButton({ beginNewChat }: {
  beginNewChat: (app?: OpenPondApp | null) => void;
}) {
  return (
    <button className="sidebar-icon" type="button" aria-label="New thread" data-tooltip="New thread" data-tooltip-placement="bottom"
      onClick={async () => {
        if (!await navigateDesktopRoute({ kind: "chat", sessionId: null })) return;
        beginNewChat(null);
      }}>
      <SquarePen size={16} />
    </button>
  );
}

type Destination = { label: string; target: ModelsRoute; active: boolean };
const benchmarkViews = [
  ["tasks", "Cases"], ["graders", "Graders"], ["versions", "Versions"],
  ["compare", "Compare"], ["configuration", "Configuration"], ["diagnostics", "Diagnostics"],
] as const;
const recordedBenchmarkViews = [
  ["overview", "Overview"], ["cases", "Cases"], ["compare", "Compare"], ["configuration", "Configuration"],
] as const;
const datasetViews = [
  ["tasks", "Tasks"], ["experiments", "Benchmarks"], ["graders", "Graders"], ["versions", "Versions"],
] as const;
const graderViews = [
  ["overview", "Overview"], ["checks", "Checks"], ["usage", "Usage"], ["versions", "Versions"],
] as const;

function resourceDestinations(route: ModelsRoute) {
  if (route.page === "experiments" || route.page === "datasets" || route.page === "graders") {
    const kind = { experiments: "Benchmarks", datasets: "Datasets", graders: "Graders" }[route.page];
    const destinations: Destination[] = [{
      label: `All ${kind.toLowerCase()}`,
      target: modelsLocation(route.page, null, { area: route.area, projectId: route.projectId }),
      active: !route.resourceId && !route.reviewSource,
    }];
    if (route.page === "datasets") {
      destinations.push({ label: "Local datasets", target: modelsLocation("tasksets"), active: false });
    }
    if (route.resourceId && route.collection === "default") {
      const recorded = route.executionKind === "recorded_evidence";
      const tabs = route.page === "experiments" ? recorded ? recordedBenchmarkViews : benchmarkViews
        : route.page === "graders" ? graderViews : route.datasetKind === "release" ? datasetViews.slice(0, 1) : datasetViews;
      const selected = route.page === "experiments" && !recorded && route.detailTab === "cases"
        ? "tasks" : route.detailTab ?? tabs[0][0];
      destinations.push(...tabs.map(([detailTab, label]) => ({
        label, target: { ...route, detailTab }, active: selected === detailTab,
      })));
    } else if (route.page === "experiments" && route.collection === "drafts") {
      destinations.push({ label: "Draft setup", target: route, active: true });
    }
    return { kind, destinations };
  }
  if (route.page === "tasksets" && !route.modelId) {
    return { kind: "Datasets", destinations: [
      { label: "All datasets", target: modelsLocation("datasets", null, { area: "console" }), active: false },
      { label: "Local datasets", target: modelsLocation("tasksets"), active: true },
    ] };
  }
  const destinations: Destination[] = [
    { label: "All models", target: modelsLocation(), active: route.page === "models" && !route.modelId },
  ];
  if (route.modelId) {
    destinations.push(
      { label: "Overview", target: modelsLocation("models", route.modelId), active: route.page === "models" },
      { label: "Datasets", target: modelsLocation("tasksets", route.modelId), active: route.page === "tasksets" || route.page === "tasks" },
    );
  }
  destinations.push(
    { label: "Runs", target: modelsLocation("runs", route.modelId), active: route.page === "runs" && route.collection !== "series" },
    { label: "Versions", target: modelsLocation("versions", route.modelId), active: route.page === "versions" },
    { label: "Comparisons", target: modelsLocation("runs", route.modelId, { collection: "series" }), active: route.collection === "series" || route.page === "evaluations" },
  );
  return { kind: "Models", destinations };
}

export function SidebarNavigation({ modelProjects, connection, account, resourceWorkspaceId }: Pick<SidebarProps, "modelProjects" | "connection" | "account" | "resourceWorkspaceId">) {
  const route = useModelsRoute();
  if (!route || !hasResourceSidebar(route.page)) return null;
  const menu = resourceDestinations(route);
  if (!menu) return null;
  const model = modelProjects?.find(project => project.id === route.modelId);
  const title = model?.name ?? menu.kind;
  return <nav className="sidebar-nav sidebar-resource-nav" aria-label={`${menu.kind} navigation`}>
    <div className="sidebar-nav-group-label sidebar-resource-title">
      <BaseModelIcon modelId={model?.baseModelId} /><span title={title}>{title}</span>
      {model ? <SidebarModelControls model={model} connection={connection}
        actorId={account?.state === "signed_in" ? account.profile?.id ?? null : null}
        apiBaseUrl={account?.apiBaseUrl ?? null} activeTeamId={resourceWorkspaceId}
        onOpenLearning={() => void navigateModelsRoute(modelsLocation("models", model.id, { detailTab: "learning" }))} /> : null}
    </div>
    {menu.destinations.map(({ label, target, active }) => <button key={modelsPath(target)}
      className={`nav-command${active ? " active" : ""}`} aria-current={active ? "page" : undefined}
      type="button" onClick={() => void navigateModelsRoute(target)}>{label}</button>)}
  </nav>;
}
