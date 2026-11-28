import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ManagedBenchmarkVersions } from "@openpond/contracts/resource-setup";
import type { TrainingModelVersion } from "openpond-sdk/training";
import type { HostedModelProjectCatalog } from "../../../hooks/hosted-model-project-types";
import { apiFetch } from "../../../api/api-client";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { desktopCandidateEvaluationClient, readCandidateTrainingResult } from "../desktop-candidate-evaluation";
import type { WorkspaceApi } from "./workspace-api";

export type BenchmarkVersionChoiceValue = { version: TrainingModelVersion; label: string };
type DisplayVersion = { jobId: string; versionHash: string; label: string };

export function SavedBenchmarkVersionPicker({ api, label, selected, onSelect, disabled, original, excludedJobId, versions, autoFocus }: {
  api: WorkspaceApi;
  label: string;
  selected?: DisplayVersion;
  onSelect(value: BenchmarkVersionChoiceValue | null): void;
  disabled: boolean;
  original?: BenchmarkVersionChoiceValue;
  excludedJobId?: string;
  versions?: ManagedBenchmarkVersions;
  autoFocus?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), [api.key, excludedJobId]);
  const candidates = useInfiniteQuery({
    queryKey: ["benchmark-version-choices", api.key], enabled: !versions,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await desktopCandidateEvaluationClient(api.connection).options(api.teamId, { afterId: pageParam });
      if (page.ownerUserId !== api.actorId || (pageParam && page.nextCursor === pageParam))
        throw new Error("The saved version catalog changed owner or page.");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const models = useQuery({
    queryKey: ["benchmark-version-model-names", api.key], enabled: !versions,
    queryFn: ({ signal }) => apiFetch<HostedModelProjectCatalog>(api.connection, "/v1/training/hosted-model-projects", { signal }),
    staleTime: 30_000,
  });
  const names = new Map((models.data?.teamId === api.teamId ? models.data.projects : [])
    .map(({ project }) => [project.id, project.name]));
  const entries = new Map((candidates.data?.pages.flatMap(page => page.items) ?? [])
    .filter(item => item.trainingJobId !== original?.version.jobId && item.trainingJobId !== excludedJobId)
    .map(item => [item.trainingJobId, item]));
  const options = versions ? (versions.baseline ? [{
    value: versions.baseline.jobId, label: "Pinned baseline", description: `Version ${versions.baseline.versionHash.slice(0, 12)}`,
  }] : []) : [...entries.values()].map(item => ({ value: item.trainingJobId,
    label: names.get(item.configurationId) ?? `Artifact ${item.artifact.id}`, description: `Training run ${item.trainingJobId}` }));
  if (original) options.unshift({ value: original.version.jobId, label: original.label,
    description: `Version ${original.version.contentHash.slice(0, 12)}` });
  if (selected && !options.some(option => option.value === selected.jobId))
    options.unshift({ value: selected.jobId, label: selected.label, description: `Version ${selected.versionHash.slice(0, 12)}` });

  async function choose(jobId: string) {
    setError(null);
    if (!jobId && !original) { onSelect(null); return; }
    if (original && jobId === original.version.jobId) { onSelect(original); return; }
    const pinned = versions?.baseline?.jobId === jobId ? versions.baseline : null;
    const choice = versions ? undefined : entries.get(jobId);
    if ((!pinned && !choice) || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const result = await readCandidateTrainingResult(api.connection, api.teamId, jobId, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.savedVersion || pinned && (result.savedVersion.contentHash !== pinned.versionHash || result.job.modelProjectId !== pinned.modelProjectId) ||
        choice && (result.job.modelProjectId !== choice.configurationId || result.candidate?.registryArtifactId !== choice.artifact.id))
        throw new Error("Save the exact version in its Model before choosing it for this Benchmark.");
      onSelect({ version: result.savedVersion, label: result.model?.name ?? result.name });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  }

  return <div className="resource-setup-input">
    <span>{label}</span>
    <DropdownSelect label={label} searchable floating value={selected?.jobId ?? ""} dialogAutoFocus={autoFocus}
      disabled={disabled || loading} options={original ? options : [
        { value: "", label: candidates.isPending ? "Loading saved versions…" : "Choose a saved Model version" }, ...options,
      ]} onChange={value => void choose(value)} />
    {!versions && candidates.isSuccess && !entries.size && !original ? <p>No matching saved Model versions on this page.</p> : null}
    {!versions && candidates.hasNextPage && <button type="button" className="training-text-button"
      disabled={disabled || candidates.isFetching} onClick={() => void candidates.fetchNextPage()}>More versions</button>}
    <ErrorToast error={error ?? candidates.error}>
      {candidates.error ? <button type="button" className="training-text-button" onClick={() => void candidates.refetch()}>Retry versions</button> : null}
    </ErrorToast>
  </div>;
}

export function BenchmarkVersionChoice({ api, original, selected, onSelect, disabled, versions }: {
  api: WorkspaceApi;
  original: BenchmarkVersionChoiceValue;
  selected: BenchmarkVersionChoiceValue;
  onSelect(value: BenchmarkVersionChoiceValue): void;
  disabled: boolean;
  versions?: ManagedBenchmarkVersions;
}) {
  const [open, setOpen] = useState(false);
  if (versions && !versions.baseline) return <span>{selected.label}</span>;
  return open ? <SavedBenchmarkVersionPicker api={api} original={original} versions={versions}
    label="Model version to run" selected={{ jobId: selected.version.jobId, versionHash: selected.version.contentHash, label: selected.label }}
    onSelect={value => { if (value) onSelect(value); }} disabled={disabled} />
    : <div className="resource-setup-input">
      <span>{selected.label}</span>
      <button type="button" className="training-text-button" disabled={disabled} onClick={() => setOpen(true)}>
        {versions ? "Choose candidate or baseline" : "Choose another saved Model version"}
      </button>
    </div>;
}
