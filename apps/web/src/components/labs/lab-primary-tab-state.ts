import { useSyncExternalStore } from "react";

export const MODEL_SECTIONS = [
  "overview",
  "tasksets",
  "versions",
  "runs",
  "serving",
] as const;

export type ModelSection = (typeof MODEL_SECTIONS)[number];

export type ModelsRoute =
  | { kind: "index" }
  | {
      kind: "project";
      projectId: string;
      section: ModelSection;
      resourceId: string | null;
      detailTab: string | null;
    };

type NavigationMode = "push" | "replace";

const SECTION_SET = new Set<string>(MODEL_SECTIONS);
const DETAIL_TABS_BY_SECTION: Partial<Record<ModelSection, Set<string>>> = {
  runs: new Set(["overview", "metrics", "evaluation", "activity", "artifacts"]),
  tasksets: new Set(["overview", "scenarios", "rewards", "validation"]),
  versions: new Set(["overview", "lineage", "evaluation", "activity"]),
};
const LEGACY_TAB_TO_SECTION: Record<string, ModelSection> = {
  evals: "versions",
  overview: "overview",
  rollouts: "runs",
  runs: "runs",
  serving: "serving",
  tasksets: "tasksets",
  training: "runs",
  versions: "versions",
};
const listeners = new Set<() => void>();
let browserListening = false;
let cachedLocation = "";
let cachedRoute: ModelsRoute | null = null;

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
  if (SECTION_SET.has(projectId)) return null;
  if (!section) {
    return {
      kind: "project",
      projectId: decodeSegment(projectId),
      section: "overview",
      resourceId: null,
      detailTab: null,
    };
  }
  if (!SECTION_SET.has(section) || section === "overview" || rest.length) {
    return null;
  }
  if (section === "serving" && (resourceId || detailTab)) return null;
  if (
    detailTab &&
    !DETAIL_TABS_BY_SECTION[section as ModelSection]?.has(detailTab)
  ) {
    return null;
  }
  return {
    kind: "project",
    projectId: decodeSegment(projectId),
    section: section as Exclude<ModelSection, "overview">,
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
  const parts = ["/models", encodeURIComponent(route.projectId)];
  if (route.section === "overview") return parts.join("/");
  parts.push(route.section);
  if (route.resourceId) parts.push(encodeURIComponent(route.resourceId));
  if (route.resourceId && route.detailTab) parts.push(route.detailTab);
  return parts.join("/");
}

export function modelsSectionFromRoute(route: ModelsRoute): ModelSection {
  return route.kind === "project" ? route.section : "overview";
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

function notify(): void {
  cachedLocation = "";
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

export function navigateModelsRoute(
  route: ModelsRoute,
  mode: NavigationMode = "push",
): void {
  if (typeof window === "undefined") return;
  const path = modelsPath(route);
  if (window.location.pathname === path && !window.location.search) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"](
    window.history.state,
    "",
    path,
  );
  notify();
}

export function modelProjectRoute(
  projectId: string | null,
  section: ModelSection = "overview",
): ModelsRoute {
  return projectId
    ? { kind: "project", projectId, section, resourceId: null, detailTab: null }
    : { kind: "index" };
}
