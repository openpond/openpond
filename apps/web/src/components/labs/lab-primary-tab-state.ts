import { useSyncExternalStore } from "react";
import type { SettingsSection } from "../../lib/app-models";

export const MODEL_SECTIONS = [
  "overview",
  "tasksets",
  "evals",
  "runs",
  "versions",
  "serving",
] as const;

export type ModelSection = (typeof MODEL_SECTIONS)[number];

export const MODEL_LIBRARY_SECTIONS = [
  "projects",
  "comparisons",
  "tasksets",
  "scorers",
  "evaluations",
  "reviews",
] as const;

export type ModelLibrarySection = (typeof MODEL_LIBRARY_SECTIONS)[number];

export type ModelsRoute =
  | { kind: "index" }
  | {
      kind: "library";
      section: ModelLibrarySection;
      resourceId: string | null;
      detailTab: string | null;
    }
  | {
      kind: "project";
      projectId: string;
      section: ModelSection;
      resourceId: string | null;
      detailTab: string | null;
    };

export type DesktopRoute =
  | { kind: "models"; route: ModelsRoute }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "chat"; sessionId: string | null }
  | {
      kind: "view";
      view: "apps" | "outputs" | "projects" | "scheduled" | "get-started";
    };

type NavigationMode = "push" | "replace";

const SECTION_SET = new Set<string>(MODEL_SECTIONS);
const LIBRARY_SECTION_SET = new Set<string>(MODEL_LIBRARY_SECTIONS);
const RETIRED_LIBRARY_SECTION_SET = new Set(["scoring"]);
const DETAIL_TABS_BY_SECTION: Partial<Record<ModelSection, Set<string>>> = {
  runs: new Set(["details", "metrics", "evaluation", "rollouts", "activity", "artifacts"]),
  tasksets: new Set(["overview", "tasks", "scoring", "graders", "attempts", "releases"]),
  evals: new Set(["overview", "comparison", "activity"]),
  versions: new Set([
    "overview",
    "metrics",
    "evaluation",
    "rollouts",
    "activity",
    "artifacts",
    "lineage",
  ]),
};
const DETAIL_TABS_BY_LIBRARY_SECTION: Partial<
  Record<ModelLibrarySection, Set<string>>
> = {
  tasksets: new Set(["overview", "tasks", "scoring", "graders", "attempts", "releases"]),
  evaluations: new Set(["overview", "comparison", "activity"]),
};
const LEGACY_TAB_TO_SECTION: Record<string, ModelSection> = {
  evals: "evals",
  overview: "overview",
  rollouts: "runs",
  runs: "runs",
  serving: "serving",
  tasksets: "tasksets",
  training: "runs",
  versions: "versions",
};
const SETTINGS_SECTIONS = new Set<SettingsSection>([
  "account",
  "notifications",
  "harness",
  "harness-refiner",
  "harness-continuous-review",
  "harness-contents",
  "harness-releases",
  "profile",
  "skills",
  "configuration",
  "context",
  "training",
  "subagents",
  "editor",
  "providers",
  "dataset-storage",
  "remote",
  "usage",
  "personalization",
  "diagnostics",
]);
const VIEW_PATHS = {
  apps: "/apps",
  outputs: "/outputs",
  projects: "/projects",
  scheduled: "/workflows",
  "get-started": "/get-started",
} as const;
type DesktopView = keyof typeof VIEW_PATHS;
const VIEW_BY_PATH = new Map<string, DesktopView>(
  (Object.entries(VIEW_PATHS) as Array<
    [DesktopView, (typeof VIEW_PATHS)[DesktopView]]
  >).map(([view, path]) => [path, view]),
);
const listeners = new Set<() => void>();
let browserListening = false;
let cachedLocation = "";
let cachedRoute: ModelsRoute | null = null;
let cachedDesktopLocation = "";
let cachedDesktopRoute: DesktopRoute | null = null;

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routeFromParts(parts: string[]): ModelsRoute | null {
  const modelsIndex = parts.lastIndexOf("models");
  if (modelsIndex < 0) return null;
  const [projectId, section, resourceId, detailTab, ...rest] = parts.slice(
    modelsIndex + 1,
  );
  if (!projectId) return { kind: "index" };
  if (LIBRARY_SECTION_SET.has(projectId)) {
    if (detailTab || rest.length) return null;
    if (
      resourceId &&
      projectId !== "comparisons" &&
      !DETAIL_TABS_BY_LIBRARY_SECTION[
        projectId as ModelLibrarySection
      ]?.has(resourceId)
    ) {
      return null;
    }
    return {
      kind: "library",
      section: projectId as ModelLibrarySection,
      resourceId: section ? decodeSegment(section) : null,
      detailTab: resourceId ?? null,
    };
  }
  if (SECTION_SET.has(projectId) || RETIRED_LIBRARY_SECTION_SET.has(projectId)) {
    return null;
  }
  if (!section) {
    return {
      kind: "project",
      projectId: decodeSegment(projectId),
      section: "overview",
      resourceId: null,
      detailTab: null,
    };
  }
  const canonicalSection = section;
  if (
    !SECTION_SET.has(canonicalSection) ||
    canonicalSection === "overview" ||
    rest.length
  ) {
    return null;
  }
  if (canonicalSection === "serving" && (resourceId || detailTab)) return null;
  if (
    detailTab &&
    !DETAIL_TABS_BY_SECTION[canonicalSection as ModelSection]?.has(detailTab)
  ) {
    return null;
  }
  return {
    kind: "project",
    projectId: decodeSegment(projectId),
    section: canonicalSection as Exclude<ModelSection, "overview">,
    resourceId: resourceId ? decodeSegment(resourceId) : null,
    detailTab: detailTab ?? null,
  };
}

export function modelsRouteFromLocation(input: {
  pathname: string;
  search?: string;
}): ModelsRoute | null {
  const route = routeFromParts(input.pathname.split("/").filter(Boolean));
  if (route) return route;
  const query = new URLSearchParams(input.search ?? "");
  const projectId = query.get("modelProjectId");
  const legacyTab = query.get("modelsTab");
  if (!projectId && !legacyTab) return null;
  if (!projectId) return { kind: "index" };
  return {
    kind: "project",
    projectId,
    section: legacyTab
      ? (LEGACY_TAB_TO_SECTION[legacyTab] ?? "overview")
      : "overview",
    resourceId: null,
    detailTab: null,
  };
}

export function modelsPath(route: ModelsRoute): string {
  if (route.kind === "index") return "/models";
  if (route.kind === "library") {
    const parts = ["/models", route.section];
    if (route.resourceId) parts.push(encodeURIComponent(route.resourceId));
    if (route.resourceId && route.detailTab) parts.push(route.detailTab);
    return parts.join("/");
  }
  const parts = ["/models", encodeURIComponent(route.projectId)];
  if (route.section === "overview") return parts.join("/");
  parts.push(route.section);
  if (route.resourceId) parts.push(encodeURIComponent(route.resourceId));
  if (route.resourceId && route.detailTab) parts.push(route.detailTab);
  return parts.join("/");
}

export function desktopRouteFromLocation(input: {
  pathname: string;
  search?: string;
}): DesktopRoute | null {
  const modelsRoute = modelsRouteFromLocation(input);
  if (modelsRoute) return { kind: "models", route: modelsRoute };
  const parts = input.pathname.split("/").filter(Boolean);
  if (parts[0] === "settings" && parts.length === 2) {
    const section = decodeSegment(parts[1]);
    return SETTINGS_SECTIONS.has(section as SettingsSection)
      ? { kind: "settings", section: section as SettingsSection }
      : null;
  }
  if (parts[0] === "chat" && parts.length <= 2) {
    return {
      kind: "chat",
      sessionId: parts[1] && parts[1] !== "new" ? decodeSegment(parts[1]) : null,
    };
  }
  const view = VIEW_BY_PATH.get(input.pathname);
  if (view) {
    return {
      kind: "view",
      view,
    };
  }
  return null;
}

export function desktopPath(route: DesktopRoute): string {
  if (route.kind === "models") return modelsPath(route.route);
  if (route.kind === "settings") return `/settings/${route.section}`;
  if (route.kind === "chat") {
    return route.sessionId
      ? `/chat/${encodeURIComponent(route.sessionId)}`
      : "/chat/new";
  }
  return VIEW_PATHS[route.view];
}

export function modelsSectionFromRoute(route: ModelsRoute): ModelSection {
  return route.kind === "project" ? route.section : "overview";
}

export function modelsRouteWithDefaultProject(
  route: ModelsRoute,
  projects: ReadonlyArray<{ id: string; updatedAt: string }>,
): ModelsRoute {
  if (route.kind !== "index" || projects.length === 0) return route;
  const mostRecent = projects.reduce((current, candidate) => {
    const updatedAtOrder = candidate.updatedAt.localeCompare(current.updatedAt);
    return updatedAtOrder > 0
      || (updatedAtOrder === 0 && candidate.id.localeCompare(current.id) > 0)
      ? candidate
      : current;
  });
  return modelProjectRoute(mostRecent.id);
}

export function modelsLibrarySectionFromRoute(
  route: ModelsRoute,
): ModelLibrarySection | null {
  return route.kind === "library" ? route.section : null;
}

function currentModelsRoute(): ModelsRoute | null {
  if (typeof window === "undefined") return null;
  const locationKey = `${window.location.pathname}${window.location.search}`;
  if (locationKey !== cachedLocation) {
    cachedLocation = locationKey;
    cachedRoute = modelsRouteFromLocation(window.location);
  }
  return cachedRoute;
}

function currentDesktopRoute(): DesktopRoute | null {
  if (typeof window === "undefined") return null;
  const locationKey = `${window.location.pathname}${window.location.search}`;
  if (locationKey !== cachedDesktopLocation) {
    cachedDesktopLocation = locationKey;
    cachedDesktopRoute = desktopRouteFromLocation(window.location);
  }
  return cachedDesktopRoute;
}

function notify(): void {
  cachedLocation = "";
  cachedDesktopLocation = "";
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined" && !browserListening) {
    window.addEventListener("popstate", notify);
    browserListening = true;
  }
  return () => {
    listeners.delete(listener);
    if (
      browserListening &&
      listeners.size === 0 &&
      typeof window !== "undefined"
    ) {
      window.removeEventListener("popstate", notify);
      browserListening = false;
    }
  };
}

export function useModelsRoute(): ModelsRoute | null {
  return useSyncExternalStore(subscribe, currentModelsRoute, () => null);
}

export function useDesktopRoute(): DesktopRoute | null {
  return useSyncExternalStore(subscribe, currentDesktopRoute, () => null);
}

export function navigateDesktopRoute(
  route: DesktopRoute,
  mode: NavigationMode = "push",
): void {
  if (typeof window === "undefined") return;
  const path = desktopPath(route);
  if (window.location.pathname === path && !window.location.search) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"](
    window.history.state,
    "",
    path,
  );
  notify();
}

export function navigateModelsRoute(
  route: ModelsRoute,
  mode: NavigationMode = "push",
): void {
  navigateDesktopRoute({ kind: "models", route }, mode);
}

export function modelProjectRoute(
  projectId: string | null,
  section: ModelSection = "overview",
): ModelsRoute {
  return projectId
    ? { kind: "project", projectId, section, resourceId: null, detailTab: null }
    : { kind: "index" };
}

export function modelLibraryRoute(
  section: ModelLibrarySection,
  resourceId: string | null = null,
  detailTab: string | null = null,
): ModelsRoute {
  return { kind: "library", section, resourceId, detailTab };
}
