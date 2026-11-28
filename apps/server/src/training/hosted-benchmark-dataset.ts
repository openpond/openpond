import { contentHash } from "@openpond/harness";
import type { ManagedBenchmarkReview } from "@openpond/contracts/resource-setup";
import { OpenPondDatasetPopulationClient, type DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import { canonicalDatasetGraderSelection, groupDatasetGraders } from "openpond-sdk/experiments";
import { OpenPondTasksetCatalogClient } from "openpond-sdk/taskset-catalog";
import type { EvaluationExperimentDraft } from "openpond-sdk/training";
import { requireHostedBenchmarkAccess, type HostedBenchmarkAccess } from "./hosted-benchmark-access.js";

export type ReviewedBenchmarkDataset = {
  selection: NonNullable<EvaluationExperimentDraft["selection"]>;
  graders: EvaluationExperimentDraft["form"]["graderChoices"][string];
};

export async function readManagedBenchmarkDataset(
  input: ManagedBenchmarkReview, loadAccess: HostedBenchmarkAccess,
): Promise<ReviewedBenchmarkDataset | null | undefined> {
  const dataset = input.dataset;
  if (!dataset) {
    if (input.split || input.samples !== undefined)
      throw new Error("Choose a released Dataset before setting a split or sample count.");
    return dataset;
  }
  const candidate = input.versions.candidate;
  if (dataset.teamId !== candidate.teamId || dataset.owner.actorId !== candidate.owner.actorId ||
    dataset.owner.apiOrigin !== candidate.owner.apiOrigin)
    throw new Error("Choose a released Dataset in the selected Model's workspace.");
  const access = await requireHostedBenchmarkAccess(candidate, loadAccess);
  const options = { apiKey: access.token, baseUrl: access.apiBaseUrl, teamId: access.teamId };
  const signal = AbortSignal.timeout(30_000);
  const catalog = new OpenPondTasksetCatalogClient(options);
  const published = await catalog.resolve(dataset.release, { signal });
  if (published.taskCount > 10_000) throw new Error("Choose a Dataset version with at most 10,000 tasks for one Benchmark.");
  const population = new OpenPondDatasetPopulationClient(options);
  let first: DatasetPopulationPage | undefined;
  let afterId: string | undefined;
  let taskCount = 0;
  const eligible: string[] = [];
  do {
    const page = await population.read({ release: dataset.release, view: "ids", limit: 1000, ...(afterId ? { afterId } : {}) }, signal);
    if (page.taskCount !== published.taskCount || (first && contentHash(page.graders) !== contentHash(first.graders)))
      throw new Error("The released Dataset population changed between pages.");
    first ??= page;
    taskCount += page.items.length;
    eligible.push(...page.items.filter(task => !input.split || task.split === input.split).map(task => task.id));
    afterId = page.nextCursor ?? undefined;
    if (taskCount > published.taskCount || (afterId && !page.items.length))
      throw new Error("The released Dataset population did not match its published task count.");
  } while (afterId);
  if (taskCount !== published.taskCount) throw new Error("The released Dataset population is incomplete.");
  if (!eligible.length) throw new Error("Choose a split with tasks in this Dataset release.");
  const available = first?.graders ?? [];
  const choices = dataset.graders
    ? dataset.graders.map(selection => {
        const grader = available.find(item => item.id === selection.id && item.version === selection.version &&
          item.contentHash === selection.contentHash);
        if (!grader) throw new Error("Choose exact Graders from this Dataset release.");
        return { ...grader, mappings: selection.mappings };
      })
    : groupDatasetGraders(available).map(({ grader }) => ({ ...grader, mappings: [] }));
  const graders = canonicalDatasetGraderSelection(choices).map(({ id, version, contentHash, mappings }) =>
    ({ id, version, contentHash, mappings }));
  if (!graders.length || graders.length > 100)
    throw new Error("Choose between one and 100 released Graders.");
  const active = await requireHostedBenchmarkAccess(candidate, loadAccess);
  if (active.token !== access.token) throw new Error("The active account changed. Reopen Benchmark setup.");
  const selected = input.samples === undefined ? eligible : eligible
    .map(id => ({ id, rank: contentHash([dataset.release.contentHash, input.seed ?? 0, id]) }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id))
    .slice(0, input.samples).map(task => task.id);
  const retained = new Set(selected);
  return {
    selection: { release: published.release, mode: "subset", ids: eligible.filter(id => retained.has(id)) },
    graders,
  };
}
