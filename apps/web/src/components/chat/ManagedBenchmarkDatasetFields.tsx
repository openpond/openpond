import { useInfiniteQuery } from "@tanstack/react-query";
import type { ManagedBenchmarkDataset, ResourceSetupDraft } from "@openpond/contracts/resource-setup";
import { groupDatasetGraders } from "openpond-sdk/experiments";
import { TasksetCatalogPageSchema, type HostedTasksetSummary } from "openpond-sdk/taskset-catalog";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { DatasetSetupGraders } from "../labs/workspace/DatasetSetupGraders";
import { useDatasetPopulation } from "../labs/workspace/useDatasetPopulation";
import type { WorkspaceApi } from "../labs/workspace/workspace-api";

type Split = ResourceSetupDraft["values"]["split"];
const splits = [{ value: "train", label: "Train" }, { value: "validation", label: "Validation" },
  { value: "test", label: "Test" }, { value: "frozen_eval", label: "Frozen evaluation" }] as const;
const releaseKey = (release: HostedTasksetSummary["release"]) => JSON.stringify([release.id, release.revision, release.contentHash]);

export function ManagedBenchmarkDatasetFields({ api, owner, field, current, split, disabled, onChoose, onSplit }: {
  api: WorkspaceApi;
  owner: ManagedBenchmarkDataset["owner"];
  field: "dataset" | "grader";
  current: ManagedBenchmarkDataset | null | undefined;
  split: Split;
  disabled: boolean;
  onChoose(dataset: ManagedBenchmarkDataset | null, split: Split): void;
  onSplit(split: Split): void;
}) {
  const catalog = useInfiniteQuery({
    queryKey: ["benchmark-released-datasets", api.key], enabled: field === "dataset",
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = TasksetCatalogPageSchema.parse(await api.request("catalogDatasets", {
        limit: 60, ...(pageParam ? { afterId: pageParam } : {}),
      }, signal));
      if (page.items.some(item => item.teamId !== api.teamId) || (pageParam && page.nextCursor === pageParam))
        throw new Error("The released Dataset catalog changed workspace or page.");
      return page;
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const population = useDatasetPopulation(api, current?.release ?? null);
  const available = population.data?.graders ?? [];
  const groups = groupDatasetGraders(available);
  const selection = current?.graders ?? (groups.length <= 100 ? groups.map(({ grader }) => ({
    id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: [],
  })) : []);
  const items = new Map(catalog.data?.pages.flatMap(page =>
    page.items.map(item => [releaseKey(item.release), item] as const)) ?? []);
  const itemOptions = [...items].map(([value, item]) => ({
    value, label: `${item.name} revision ${item.release.revision}`, description: `${item.taskCount} tasks`, disabled: item.taskCount === 0,
  }));
  const currentKey = current ? releaseKey(current.release) : "";
  if (current && !items.has(currentKey)) itemOptions.unshift({
    value: currentKey, label: `${current.label} revision ${current.release.revision}`, description: "Selected release", disabled: false,
  });
  const populationSplits = new Set(population.data?.items.map(item => item.split));
  const displayedError = field === "grader" ? population.error : catalog.error ?? population.error;

  return <div className="resource-setup-fields">
    {field === "dataset" ? <>
      <div className="resource-setup-input">
        <span>Released Dataset</span>
        <DropdownSelect label="Released Dataset" value={currentKey} searchable dialogAutoFocus
          options={[{ value: "", label: catalog.isPending ? "Loading released Datasets…" : "Choose a released Dataset" }, ...itemOptions]}
          disabled={disabled} onChange={value => {
            if (!value) { onChoose(null, undefined); return; }
            const selected = items.get(value);
            if (selected && value !== currentKey && api.actorId) {
              // Owner and API origin come from the prompt workspace, not catalog labels.
              onChoose({ teamId: selected.teamId, owner,
                release: selected.release, label: selected.name }, undefined);
            }
          }} />
        {catalog.hasNextPage && <button type="button" className="training-text-button" disabled={disabled || catalog.isFetching}
          onClick={() => void catalog.fetchNextPage()}>More Dataset releases</button>}
      </div>
      {current && <div className="resource-setup-input">
        <span>Split</span>
        <DropdownSelect label="Split" value={split ?? ""} disabled={disabled || !population.data}
          options={[{ value: "", label: "All released tasks" }, ...splits.map(option => ({
            ...option, disabled: option.value !== split && !populationSplits.has(option.value),
          }))]}
          onChange={value => onSplit(splits.find(option => option.value === value)?.value)} />
        {population.data ? <p>{population.data.items.filter(item => !split || item.split === split).length} tasks in this selection</p> : null}
      </div>}
    </> : current ? population.data ? (
      <fieldset className="resource-setup-grader-fields" aria-label="Released Graders" disabled={disabled}>
        {available.length ? <DatasetSetupGraders graders={available} selected={selection}
          onChange={graders => { if (graders.length <= 100) onChoose({ ...current, graders }, split); }} />
          : <p>This Dataset release has no Graders.</p>}
      </fieldset>
    ) : population.isPending ? <p role="status">Loading released Graders…</p> : null
      : <p>Choose a released Dataset to see its Graders.</p>}
    <ErrorToast error={displayedError}>
      {displayedError && <button type="button" className="training-text-button" onClick={() => {
        if (field === "dataset" && catalog.error) void catalog.refetch();
        else void population.refetch();
      }}>Retry released inputs</button>}
    </ErrorToast>
  </div>;
}
