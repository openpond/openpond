import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { TrainingModelVersion } from "openpond-sdk/training";
import type { HostedModelProjectCatalog } from "../../../hooks/hosted-model-project-types";
import { apiFetch } from "../../../api/api-client";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { desktopCandidateEvaluationClient, readCandidateTrainingResult } from "../desktop-candidate-evaluation";
import type { WorkspaceApi } from "./workspace-api";

export type BenchmarkVersionChoiceValue = { version: TrainingModelVersion; label: string };

export function BenchmarkVersionChoice({ api, original, selected, onSelect, disabled }: {
  api: WorkspaceApi;
  original: BenchmarkVersionChoiceValue;
  selected: BenchmarkVersionChoiceValue;
  onSelect(value: BenchmarkVersionChoiceValue): void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), [api.key]);
  const candidates = useInfiniteQuery({
    queryKey: ["benchmark-version-choices", api.key], enabled: open,
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
    queryKey: ["benchmark-version-model-names", api.key], enabled: open,
    queryFn: ({ signal }) => apiFetch<HostedModelProjectCatalog>(api.connection, "/v1/training/hosted-model-projects", { signal }),
    staleTime: 30_000,
  });
  const names = new Map((models.data?.teamId === api.teamId ? models.data.projects : [])
    .map(({ project }) => [project.id, project.name]));
  const entries = [...new Map((candidates.data?.pages.flatMap(page => page.items) ?? [])
    .filter(item => item.trainingJobId !== original.version.jobId).map(item => [item.trainingJobId, item])).values()];

  async function choose(jobId: string) {
    setError(null);
    if (jobId === original.version.jobId) { onSelect(original); return; }
    const choice = entries.find(item => item.trainingJobId === jobId);
    if (!choice || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const result = await readCandidateTrainingResult(api.connection, api.teamId, choice.trainingJobId, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.savedVersion || result.job.modelProjectId !== choice.configurationId || result.candidate?.registryArtifactId !== choice.artifact.id)
        throw new Error("Save the exact version in its Model before choosing it for this Benchmark.");
      onSelect({ version: result.savedVersion, label: result.model?.name ?? result.name });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  }
  return <div className="resource-setup-input">
    {open ? <>
      <DropdownSelect label="Model version to run" searchable floating value={selected.version.jobId}
        disabled={disabled || loading}
        options={[
          { value: original.version.jobId, label: original.label, description: `Version ${original.version.contentHash.slice(0, 12)}` },
          ...entries.map(item => ({ value: item.trainingJobId,
            label: names.get(item.configurationId) ?? `Artifact ${item.artifact.id}`,
            description: `Training run ${item.trainingJobId}` })),
        ]} onChange={value => void choose(value)} />
      {candidates.hasNextPage && <button type="button" className="training-text-button"
        disabled={disabled || candidates.isFetching} onClick={() => void candidates.fetchNextPage()}>More versions</button>}
    </> : <>
      <span>{selected.label}</span>
      <button type="button" className="training-text-button" disabled={disabled} onClick={() => setOpen(true)}>
        Choose another saved Model version
      </button>
    </>}
    <ErrorToast error={error ?? candidates.error}>
      {candidates.error ? <button type="button" className="training-text-button" onClick={() => void candidates.refetch()}>Retry versions</button> : null}
    </ErrorToast>
  </div>;
}
