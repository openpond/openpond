import { useQuery } from "@tanstack/react-query";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { WorkspaceApi } from "./workspace-api";

/** Collect only released task identities for setup; authoring drafts never
 * provide executable population membership. Every page retains the same pin. */
export function useDatasetPopulation(api: WorkspaceApi, release: DatasetPopulationPage["release"] | null, localSourceId?:string, ready=true) {
  return useQuery({ queryKey: ["evaluation-workspace", api.key, "setup-population", release?.contentHash,localSourceId], enabled: Boolean(release)&&ready, queryFn: async ({ signal }) => {
    const items: DatasetPopulationPage["items"] = [];
    let afterId: string | undefined;
    let first: DatasetPopulationPage | null = null;
    do {
      const page = localSourceId?await api.local<DatasetPopulationPage>("sourceDataset",{id:localSourceId,view:"ids",limit:10_000,...(afterId?{afterId}:{})},signal):await api.request<DatasetPopulationPage>("datasetPopulation", { release, view: "ids", limit: 10_000, ...(afterId ? { afterId } : {}) }, signal);
      if (page.taskCount > 10_000) throw new Error("Choose a Dataset version with at most 10,000 tasks for one Experiment.");
      if (first && (page.taskCount !== first.taskCount || JSON.stringify(page.graders) !== JSON.stringify(first.graders))) throw new Error("The released Dataset population changed between pages.");
      first ??= page;
      items.push(...page.items);
      if (page.nextCursor && page.nextCursor === afterId) throw new Error("Dataset population cursor did not advance.");
      afterId = page.nextCursor ?? undefined;
    } while (afterId);
    if (!first || items.length !== first.taskCount) throw new Error("Dataset population is incomplete.");
    return { ...first, items };
  } });
}
