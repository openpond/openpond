export const MODELS_PAGES = ["models", "tasksets", "rewards", "evaluations", "runs", "versions", "serving"] as const;
export type ModelsPage = (typeof MODELS_PAGES)[number];
export type ModelsCollection = "default" | "results" | "review" | "series" | "drafts" | "new" | "formats" | "batches" | "comparisons" | "scorers";
export interface ModelsRoute {
  page: ModelsPage;
  modelId: string | null;
  collection: ModelsCollection;
  resourceId: string | null;
  detailTab: string | null;
  query: string;
  after: string | null;
}

export const MODELS_PAGE_LABELS: Record<ModelsPage, string> = {
  models: "Models", tasksets: "Tasksets", rewards: "Rewards", evaluations: "Evaluations", runs: "Runs", versions: "Versions", serving: "Serving",
};
const collections: Partial<Record<ModelsPage, readonly ModelsCollection[]>> = {
  tasksets: ["drafts", "formats", "batches"], rewards: ["scorers"], evaluations: ["results", "review", "comparisons"], runs: ["series", "new"],
};
const detailTabs: Partial<Record<ModelsPage, readonly string[]>> = {
  tasksets: ["overview", "tasks", "reward", "attempts", "releases"],
  rewards: ["definition", "usage", "evidence"],
  evaluations: ["overview", "comparison", "activity"],
  runs: ["details", "metrics", "evaluation", "rollouts", "activity", "artifacts"],
  versions: ["overview", "metrics", "evaluation", "rollouts", "activity", "artifacts"],
};

export function modelsLocation(page: ModelsPage = "models", modelId: string | null = null, detail: Partial<Omit<ModelsRoute, "page" | "modelId">> = {}): ModelsRoute {
  return { page, modelId, collection: page === "evaluations" ? "results" : "default", resourceId: null, detailTab: null, query: "", after: null, ...detail };
}

export function modelsRouteFromLocation(input: { pathname: string; search?: string }): ModelsRoute | null {
  const encoded = input.pathname.split("/").filter(Boolean);
  if (encoded[0] !== "models") return null;
  let parts: string[];
  try { parts = encoded.slice(1).map(decodeURIComponent); } catch { return null; }
  if (parts.some((part) => !part.trim() || part.length > 2_000 || part.includes("\u0000"))) return null;
  const page = (parts.shift() ?? "models") as ModelsPage;
  if (!MODELS_PAGES.includes(page) || (page === "models" && (encoded.length > 1 || parts.length))) return null;
  let collection: ModelsCollection = page === "evaluations" ? "results" : "default";
  if (collections[page]?.includes(parts[0] as ModelsCollection)) collection = parts.shift() as ModelsCollection;
  else if (page === "evaluations" && parts.length) return null;
  const resourceId = parts.shift() ?? null;
  const detailTab = parts.shift() ?? null;
  if (parts.length || (detailTab && !resourceId)) return null;
  if (page === "models" && resourceId) return null;
  if (collection === "drafts" || collection === "new") {
    if (!resourceId || detailTab) return null;
  } else if (collection === "series") {
    // A series entry is an identity, not a display tab.
  } else if (["review", "formats", "batches", "comparisons", "scorers"].includes(collection)) {
    if (detailTab) return null;
  } else if (detailTab && !detailTabs[page]?.includes(detailTab)) return null;
  if (page === "serving" && detailTab) return null;
  const query = new URLSearchParams(input.search ?? "");
  if ([...query.keys()].some((key) => !["model", "q", "after"].includes(key)) || [...query.keys()].some((key) => query.getAll(key).length !== 1)) return null;
  const modelId = query.get("model");
  const search = query.get("q") ?? "";
  const after = query.get("after");
  if ((modelId !== null && (!modelId.trim() || modelId.length > 500)) || search.length > 1_000 || (after !== null && (!after.trim() || after.length > 2_000))) return null;
  return modelsLocation(page, modelId, { collection, resourceId, detailTab, query: search, after });
}

export function modelsPath(route: ModelsRoute): string {
  const parts = ["/models"];
  if (route.page !== "models") parts.push(route.page);
  if (route.collection !== "default") parts.push(route.collection);
  if (route.resourceId) parts.push(encodeURIComponent(route.resourceId));
  if (route.resourceId && route.detailTab) parts.push(encodeURIComponent(route.detailTab));
  const query = new URLSearchParams();
  if (route.modelId) query.set("model", route.modelId);
  if (route.query) query.set("q", route.query);
  if (route.after) query.set("after", route.after);
  return `${parts.join("/")}${query.size ? `?${query}` : ""}`;
}

export function changeModelsScope(route: ModelsRoute, modelId: string | null): ModelsRoute {
  return modelsLocation(route.page, modelId, { collection: route.collection === "new" || route.collection === "drafts" ? "default" : route.collection });
}

export function modelsResourceLocation(route: ModelsRoute, resourceId: string | null, detailTab: string | null = null): ModelsRoute {
  return { ...route, resourceId, detailTab, after: null };
}
