export const MODELS_PAGES = ["get-started", "home", "inbox", "models", "datasets", "graders", "experiments", "tasks", "tasksets", "labeling", "rewards", "evaluations", "runs", "versions", "serving"] as const;
export type ModelsPage = (typeof MODELS_PAGES)[number];
export type ModelsCollection = "default" | "results" | "review" | "series" | "drafts" | "new" | "formats" | "batches" | "comparisons" | "scorers" | "combined";
export interface ModelsRoute {
  page: ModelsPage;
  area?: "console";
  modelId: string | null;
  collection: ModelsCollection;
  resourceId: string | null;
  detailTab: string | null;
  query: string;
  after: string | null;
  sourceId?: string | null;
  reviewSource?: { id: string; snapshotHash: string; boundaryId: string; boundaryRevisionHash: string };
  datasetKind?: "release";
  projectId?: string | null;
  executionId?: null;
  passId?: string | null;
  sort?: "id" | "name" | "updated";
  revision?: number;
  contentHash?: string;
  executionLocation?: "local" | "hosted";
  executionKind?: "recorded_evidence";
}

export const MODELS_PAGE_LABELS: Record<ModelsPage, string> = {
  "get-started": "Get started", home: "Home", inbox: "Inbox", models: "Models", datasets: "Datasets", graders: "Graders", experiments: "Experiments", tasks: "Tasks", tasksets: "Tasksets", labeling: "Labeling", rewards: "Rewards", evaluations: "Runs", runs: "Training", versions: "Versions", serving: "Serving",
};
const collections: Partial<Record<ModelsPage, readonly ModelsCollection[]>> = {
  tasks: ["drafts"], tasksets: ["drafts", "formats", "batches"], rewards: ["scorers", "combined"], evaluations: ["results", "review", "comparisons"], runs: ["series", "new"],
};
const detailTabs: Partial<Record<ModelsPage, readonly string[]>> = {
  datasets: ["tasks", "experiments", "graders", "versions"],
  graders: ["overview", "checks", "usage", "versions"],
  experiments: ["tasks", "graders", "versions", "diagnostics", "overview", "cases", "compare", "configuration"],
  tasksets: ["overview", "tasks", "reward", "attempts", "releases"],
  rewards: ["definition", "usage", "evidence"],
  evaluations: ["overview", "comparison", "activity"],
  runs: ["diagnostics", "details", "metrics", "evaluation", "rollouts", "activity", "artifacts"],
  versions: ["overview", "metrics", "evaluation", "rollouts", "activity", "artifacts"],
};

export function modelsLocation(page: ModelsPage = "models", modelId: string | null = null, detail: Partial<Omit<ModelsRoute, "page" | "modelId">> = {}): ModelsRoute {
  if (page === "evaluations" && detail.collection === "review") return modelsLocation("labeling", modelId, { ...detail, collection: "default" });
  return { page, modelId: ["get-started", "home", "inbox", "datasets", "graders", "experiments"].includes(page) ? null : modelId, collection: page === "evaluations" ? "results" : "default", resourceId: null, detailTab: null, query: "", after: null, ...detail };
}

export function modelsRouteFromLocation(input: { pathname: string; search?: string }): ModelsRoute | null {
  const encoded = input.pathname.split("/").filter(Boolean);
  if (encoded[0] !== "models" && encoded[0] !== "console") return null;
  let parts: string[];
  try { parts = encoded.slice(1).map(decodeURIComponent); } catch { return null; }
  if (parts.some((part) => !part.trim() || part.length > 2_000 || part.includes("\u0000"))) return null;
  const pathModelId = parts[0] && !MODELS_PAGES.includes(parts[0] as ModelsPage) ? parts.shift()! : null;
  if (pathModelId && (pathModelId.length > 500 || ["projects", "scorers"].includes(pathModelId))) return null;
  if (parts[0] === "runs" && parts[1] === "evaluations") parts.splice(0, 2, "evaluations", "results");
  if (parts[0] === "runs" && parts[1] === "comparisons") parts.splice(0, 2, "evaluations", "comparisons");
  const pageSegment = parts.shift();
  const page = (pageSegment ?? "models") as ModelsPage;
  if (!MODELS_PAGES.includes(page) || pageSegment === "models" || (pathModelId && page === "get-started")) return null;
  let collection: ModelsCollection = page === "evaluations" ? "results" : "default";
  if (collections[page]?.includes(parts[0] as ModelsCollection)) collection = parts.shift() as ModelsCollection;
  else if (page === "evaluations" && parts.length) return null;
  if (page === "experiments" && parts[0] === "history") return null;
  const resourceId = parts.shift() ?? null;
  const detailTab = parts.shift() ?? null;
  if (parts.length || (detailTab && !resourceId)) return null;
  if ((page === "models" || page === "get-started" || page === "home") && resourceId) return null;
  if (collection === "drafts" || collection === "new") {
    if (!resourceId || detailTab) return null;
  } else if (collection === "series") {
    // A series entry is an identity, not a display tab.
  } else if (["review", "formats", "batches", "comparisons", "scorers", "combined"].includes(collection)) {
    if (detailTab) return null;
  } else if (detailTab && !detailTabs[page]?.includes(detailTab)) return null;
  if (page === "serving" && detailTab) return null;
  const query = new URLSearchParams(input.search ?? "");
  if ([...query.keys()].some((key) => !["model", "q", "after", "source", "project", "pass", "dataset", "revision", "hash", "sort", "location", "kind", "review_source", "review_snapshot", "review_boundary", "review_revision"].includes(key)) || [...query.keys()].some((key) => query.getAll(key).length !== 1)) return null;
  const reviewFields = ["review_source", "review_snapshot", "review_boundary", "review_revision"] as const;
  const hasReview = reviewFields.some(key => query.has(key));
  if (hasReview && (page !== "datasets" || resourceId || query.get("location") === "local" || reviewFields.some(key => !query.get(key))
    || [query.get("review_source")!, query.get("review_boundary")!].some(id => !id.trim() || id.length > 500 || id.includes("\u0000"))
    || [query.get("review_snapshot")!, query.get("review_revision")!].some(hash => !/^[a-f0-9]{64}$/.test(hash)))) return null;
  const reviewSource = hasReview ? { id: query.get("review_source")!, snapshotHash: query.get("review_snapshot")!, boundaryId: query.get("review_boundary")!, boundaryRevisionHash: query.get("review_revision")! } : undefined;
  const sort = query.get("sort");
  if (sort !== null && (page !== "datasets" || !["id", "name", "updated"].includes(sort))) return null;
  const revision = query.has("revision") ? Number(query.get("revision")) : undefined;
  const contentHash = query.get("hash") ?? undefined;
  const permitsReleasePin=["datasets","graders"].includes(page);
  if ((revision !== undefined || contentHash !== undefined) && (!resourceId || !permitsReleasePin || !Number.isSafeInteger(revision) || revision! <= 0 || !/^[a-f0-9]{64}$/.test(contentHash ?? ""))) return null;
  const sourceId = query.get("source");
  if (sourceId !== null && ((page !== "labeling" && (page !== "evaluations" || collection !== "review")) || !sourceId.trim() || sourceId.length > 500)) return null;
  if (query.has("dataset") && (page !== "datasets" || !resourceId || query.get("dataset") !== "release")) return null;
  const hosted = ["home", "inbox", "datasets", "graders", "experiments"].includes(page);
  const hostedTraining = page === "runs" && Boolean(resourceId?.startsWith("hosted-run:") || resourceId?.startsWith("hosted-policy:"));
  const executionLocation=query.get("location");
  if(executionLocation!==null&&(!hosted||!["local","hosted"].includes(executionLocation)))return null;
  const executionKind=query.get("kind");
  if(executionKind!==null&&(page!=="experiments"||!resourceId||executionLocation==="local"||executionKind!=="recorded_evidence"))return null;
  if (encoded[0] === "console" && !hosted && page !== "runs") return null;
  const projectId = query.get("project") === "all" ? null : query.get("project");
  const passId = query.get("pass");
  if ([projectId, passId].some(id => id !== null && (!id.trim() || id.length > 240)) || (!hosted && !hostedTraining && (projectId || passId)) || (page !== "experiments" && passId) || ((hosted || hostedTraining) && pathModelId)) return null;
  if (passId && !resourceId) return null;
  const legacyModelId = query.get("model");
  if (hosted && legacyModelId !== null) return null;
  if (pathModelId && legacyModelId && pathModelId !== legacyModelId) return null;
  const modelId = pathModelId ?? legacyModelId;
  if (page === "get-started" && query.size !== 0) return null;
  const search = query.get("q") ?? "";
  const after = query.get("after");
  if ((modelId !== null && (!modelId.trim() || modelId.length > 500)) || search.length > 1_000 || (after !== null && (!after.trim() || after.length > 2_000))) return null;
  return modelsLocation(page, modelId, { ...(reviewSource ? { reviewSource } : {}), collection, resourceId, detailTab, query: search, after, ...(executionKind?{executionKind:"recorded_evidence" as const}:{}), ...(executionLocation?{executionLocation:executionLocation as "local"|"hosted"}:{}), ...(sort ? { sort: sort as "id" | "name" | "updated" } : {}), ...(revision !== undefined ? { revision, contentHash } : {}), ...(query.get("dataset") === "release" ? { datasetKind: "release" } : {}), ...(encoded[0] === "console" ? { area: "console" } : {}), ...((hosted || hostedTraining) ? { ...(query.has("project") ? { projectId } : {}), ...(query.has("pass") ? { passId } : {}) } : {}), ...(sourceId !== null ? { sourceId } : {}) });
}

export function modelsPath(route: ModelsRoute): string {
  const parts = [route.area === "console" ? "/console" : "/models"];
  if (route.modelId) parts.push(encodeURIComponent(route.modelId));
  if (route.page === "evaluations" && route.collection === "review") return modelsPath(modelsLocation("labeling", route.modelId, { collection: "default", resourceId: route.resourceId, sourceId: route.sourceId, query: route.query, after: route.after }));
  if (route.page === "evaluations") parts.push("runs", route.collection === "comparisons" ? "comparisons" : "evaluations");
  else {
    if (route.page !== "models") parts.push(route.page);
    if (route.collection !== "default") parts.push(route.collection);
  }
  if (route.resourceId) parts.push(encodeURIComponent(route.resourceId));
  if (route.resourceId && route.detailTab) parts.push(encodeURIComponent(route.detailTab));
  const query = new URLSearchParams();
  if (route.page === "datasets" && !route.resourceId && route.reviewSource) {
    query.set("review_source", route.reviewSource.id); query.set("review_snapshot", route.reviewSource.snapshotHash);
    query.set("review_boundary", route.reviewSource.boundaryId); query.set("review_revision", route.reviewSource.boundaryRevisionHash);
  }
  if(route.executionLocation)query.set("location",route.executionLocation);
  if (route.projectId) query.set("project", route.projectId);
  else if (route.projectId === null && ["home", "inbox", "datasets", "graders", "experiments"].includes(route.page)) query.set("project", "all");
  if (route.page === "datasets" && route.resourceId && route.datasetKind === "release") query.set("dataset", "release");
  if (route.page === "datasets" && route.sort) query.set("sort", route.sort);
  if (route.revision !== undefined && route.contentHash && route.resourceId && ["datasets", "graders"].includes(route.page)) { query.set("revision", String(route.revision)); query.set("hash", route.contentHash); }
  if (route.passId) query.set("pass", route.passId);
  if (route.page === "experiments" && route.resourceId && route.executionKind) query.set("kind",route.executionKind);
  if (route.query) query.set("q", route.query);
  if (route.after) query.set("after", route.after);
  if ((route.page === "labeling" || (route.page === "evaluations" && route.collection === "review")) && route.sourceId) query.set("source", route.sourceId);
  return `${parts.join("/")}${query.size ? `?${query}` : ""}`;
}

export function changeModelsScope(route: ModelsRoute, modelId: string | null): ModelsRoute {
  return modelsLocation(route.page, modelId, { ...(route.area ? { area: route.area } : {}), ...(["home", "inbox", "datasets", "graders", "experiments"].includes(route.page) && route.projectId !== undefined ? { projectId: route.projectId } : {}), collection: route.collection === "new" || route.collection === "drafts" ? "default" : route.collection });
}

export function modelsResourceLocation(route: ModelsRoute, resourceId: string | null, detailTab: string | null = null): ModelsRoute {
  return { ...route, resourceId, detailTab, after: null, ...(resourceId !== route.resourceId ? { revision: undefined, contentHash: undefined } : {}) };
}
