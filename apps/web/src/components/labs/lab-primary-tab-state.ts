import { useSyncExternalStore } from "react";
import type { SettingsSection } from "../../lib/app-models";
import { modelsPath, modelsRouteFromLocation, type ModelsRoute } from "./models-route";
export * from "./models-route";

export type DesktopRoute =
  | { kind: "models"; route: ModelsRoute }
  | { kind: "models_unavailable"; pathname: string; search: string }
  | { kind: "settings"; section: SettingsSection; returnTo?: string }
  | { kind: "chat"; sessionId: string | null }
  | { kind: "view"; view: "apps" | "outputs" | "projects" | "scheduled" | "get-started" };
type NavigationMode = "push" | "replace";
type NavigationGuard = (destination: string) => boolean | Promise<boolean>;
const guards = new Set<NavigationGuard>();
const listeners = new Set<() => void>();
const settingsSections = new Set<SettingsSection>(["account", "notifications", "harness", "harness-refiner", "harness-continuous-review", "harness-contents", "harness-releases", "profile", "skills", "configuration", "context", "training", "subagents", "editor", "providers", "dataset-storage", "remote", "usage", "personalization", "diagnostics"]);
const viewPaths = { apps: "/apps", outputs: "/outputs", projects: "/projects", scheduled: "/workflows", "get-started": "/get-started" } as const;
let listening = false;
let cacheKey = "";
let cachedDesktop: DesktopRoute | null = null;
let cachedModels: ModelsRoute | null = null;
let acceptedPath = "";
let acceptedIndex = 0;
let restoring = false;
let deciding = false;

export function desktopRouteFromLocation(input: { pathname: string; search?: string }): DesktopRoute | null {
  const route = modelsRouteFromLocation(input);
  if (route) return { kind: "models", route };
  const parts = input.pathname.split("/").filter(Boolean);
  if (parts[0] === "models") return { kind: "models_unavailable", pathname: input.pathname, search: input.search ?? "" };
  if (parts[0] === "settings" && parts.length === 2 && settingsSections.has(parts[1] as SettingsSection)) {
    const returnTo = safeModelsReturn(new URLSearchParams(input.search ?? "").get("returnTo"));
    return { kind: "settings", section: parts[1] as SettingsSection, ...(returnTo ? { returnTo } : {}) };
  }
  if (parts[0] === "chat" && parts.length <= 2) {
    try { return { kind: "chat", sessionId: parts[1] && parts[1] !== "new" ? decodeURIComponent(parts[1]) : null }; } catch { return null; }
  }
  const view = (Object.keys(viewPaths) as Array<keyof typeof viewPaths>).find((key) => viewPaths[key] === input.pathname);
  return view ? { kind: "view", view } : null;
}

export function desktopPath(route: DesktopRoute): string {
  if (route.kind === "models") return modelsPath(route.route);
  if (route.kind === "models_unavailable") return `${route.pathname}${route.search}`;
  if (route.kind === "settings") {
    const returnTo = safeModelsReturn(route.returnTo ?? null);
    return `/settings/${route.section}${returnTo ? `?${new URLSearchParams({ returnTo })}` : ""}`;
  }
  if (route.kind === "chat") return route.sessionId ? `/chat/${encodeURIComponent(route.sessionId)}` : "/chat/new";
  return viewPaths[route.view];
}

export function settingsReturnRoute(route: DesktopRoute | null): DesktopRoute {
  const returnTo = route?.kind === "settings" ? safeModelsReturn(route.returnTo ?? null) : null;
  if (returnTo) {
    const url = new URL(returnTo, "https://local.openpond.invalid");
    const parsed = modelsRouteFromLocation(url);
    if (parsed) return { kind: "models", route: parsed };
  }
  return { kind: "chat", sessionId: null };
}

function safeModelsReturn(value: string | null): string | null {
  if (!value || value.length > 6_000 || !value.startsWith("/models") || value.startsWith("//")) return null;
  const url = new URL(value, "https://local.openpond.invalid");
  if (url.origin !== "https://local.openpond.invalid" || url.hash) return null;
  const route = modelsRouteFromLocation(url);
  return route ? modelsPath(route) : null;
}

function locationPath(): string { return `${window.location.pathname}${window.location.search}`; }
function readLocation() {
  if (typeof window === "undefined") return;
  // Browser Back changes window.location before a draft-exit decision resolves.
  // Render the last accepted location until the guard accepts the transition.
  const key = listening ? acceptedPath : locationPath();
  if (key === cacheKey) return;
  cacheKey = key;
  cachedDesktop = desktopRouteFromLocation(new URL(key, window.location.origin));
  cachedModels = cachedDesktop?.kind === "models" ? cachedDesktop.route : null;
}
function notify() {
  cacheKey = "";
  readLocation();
  for (const listener of listeners) listener();
}
async function permit(path: string): Promise<boolean> {
  if (deciding) return false;
  deciding = true;
  try { for (const guard of guards) if (!await guard(path)) return false; return true; }
  finally { deciding = false; }
}
function historyState(index: number) { return { ...window.history.state, openpondNavigationIndex: index }; }
let popGeneration = 0;
async function onPopState() {
  if (restoring) { restoring = false; return; }
  const generation = ++popGeneration;
  const targetPath = locationPath();
  const targetIndex = typeof window.history.state?.openpondNavigationIndex === "number" ? window.history.state.openpondNavigationIndex : acceptedIndex - 1;
  const allowed = await permit(targetPath);
  if (generation !== popGeneration) return;
  if (!allowed) {
    if (targetIndex !== acceptedIndex) { restoring = true; window.history.go(acceptedIndex - targetIndex); }
    else window.history.replaceState(historyState(acceptedIndex), "", acceptedPath);
    return;
  }
  acceptedPath = targetPath;
  acceptedIndex = targetIndex;
  window.history.replaceState(historyState(acceptedIndex), "", targetPath);
  notify();
}
function startListening() {
  if (listening || typeof window === "undefined") return;
  acceptedPath = locationPath();
  acceptedIndex = typeof window.history.state?.openpondNavigationIndex === "number" ? window.history.state.openpondNavigationIndex : 0;
  window.history.replaceState(historyState(acceptedIndex), "", acceptedPath);
  window.addEventListener("popstate", onPopState);
  listening = true;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startListening();
  return () => { listeners.delete(listener); };
}
export function registerDesktopNavigationGuard(guard: NavigationGuard): () => void {
  guards.add(guard);
  startListening();
  return () => { guards.delete(guard); };
}
export function useModelsRoute(): ModelsRoute | null {
  return useSyncExternalStore(subscribe, () => { readLocation(); return cachedModels; }, () => null);
}
export function useDesktopRoute(): DesktopRoute | null {
  return useSyncExternalStore(subscribe, () => { readLocation(); return cachedDesktop; }, () => null);
}
export async function navigateDesktopRoute(route: DesktopRoute, mode: NavigationMode = "push"): Promise<boolean> {
  if (typeof window === "undefined") return false;
  startListening();
  if (route.kind === "settings" && !route.returnTo) {
    const current = desktopRouteFromLocation(window.location);
    const returnTo = current?.kind === "models" ? modelsPath(current.route) : current?.kind === "settings" ? current.returnTo : undefined;
    if (returnTo) route = { ...route, returnTo };
  }
  const path = desktopPath(route);
  if (locationPath() === path) return true;
  if (!await permit(path)) return false;
  if (mode === "push") acceptedIndex++;
  window.history[mode === "replace" ? "replaceState" : "pushState"](historyState(acceptedIndex), "", path);
  acceptedPath = path;
  notify();
  return true;
}
export function navigateModelsRoute(route: ModelsRoute, mode: NavigationMode = "push"): Promise<boolean> {
  return navigateDesktopRoute({ kind: "models", route }, mode);
}
