import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { contentHash } from "@openpond/harness";
import { SaveExperimentSchema, groupDatasetGraders, canonicalDatasetGraderSelection, type ExperimentDefinition, type PreparedHarnessExperimentSchema } from "openpond-sdk/experiments";
import type { ModelTasksetRunRequest } from "openpond-sdk/model-taskset-runs";
import type { HostedTasksetSummary } from "openpond-sdk/taskset-catalog";
import type { z } from "zod";
import { modelsRouteFromLocation, type ModelsRoute } from "../models-route";
import { useDraftNavigation } from "../useDraftNavigation";
import { EvaluationCard } from "./EvaluationPresentation";
import { DatasetSetupGraders } from "./DatasetSetupGraders";
import { ReleasedDatasetPicker } from "./ReleasedDatasetPicker";
import { useDatasetPopulation } from "./useDatasetPopulation";
import { experimentPopulation } from "./experiment-population";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { WorkspacePanel } from "./WorkspacePanel";
import type { Inventory, WorkspaceApi } from "./workspace-api";
type Prepared = z.infer<typeof PreparedHarnessExperimentSchema>;
export function ExperimentSetupPanel({ api, inventory, route, navigate, onSaved }: { api: WorkspaceApi; inventory: Inventory | null; route: ModelsRoute; navigate: (route: ModelsRoute) => void; onSaved: (value: ExperimentDefinition) => void }) {
  const setup = useEvaluationSetup();
  const draft = setup.draft!;
  const { name, release, modelId, budget, outputTokens, prompt, targetId, seed } = draft;
  const existing = setup.existing;
  const patch = (value: Partial<typeof draft>) => setup.setDraft(previous => previous ? { ...previous, ...value } : previous);
  const project = inventory?.projects.projects.find(item => item.id === api.projectId);
  const selectedTarget = project?.content.targets.find(target => target.id === targetId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const population = useDatasetPopulation(api, release);
  const choices = population.data ? groupDatasetGraders(population.data.graders) : [];
  const graders = release ? draft.graderChoices[release.contentHash] ?? (existing?.request.taskset.contentHash === release.contentHash ? existing.graders.map(grader => ({ id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: grader.mappings ?? [] })) : choices.length <= 100 ? choices.map(({ grader }) => ({ id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: [] })) : []) : [];
  let graderConflict: string | null = null;
  let canonicalGraders = graders;
  if (population.data) {
    try {
      canonicalGraders = canonicalDatasetGraderSelection(graders.map(selection => {
        const pin = population.data!.graders.find(item => item.id === selection.id && item.version === selection.version && item.contentHash === selection.contentHash);
        if (!pin) throw new Error("A selected grader is no longer in this exact Dataset release. Choose its released grader again.");
        return { ...pin, mappings: selection.mappings };
      })).map(({ id, version, contentHash, mappings }) => ({ id, version, contentHash, mappings }));
    } catch (cause) { graderConflict = cause instanceof Error ? cause.message : String(cause); }
  }
  const models = useQuery({ queryKey: ["evaluation-workspace", api.key, "modelChoices", release?.contentHash], enabled: Boolean(release), queryFn: ({ signal }) => api.request<{ available: boolean; unavailableReason: string | null; models: Array<{ id: string; name: string }> }>("modelChoices", { taskset: release }, signal) });
  const summary = useQuery({ queryKey: ["evaluation-workspace", api.key, "resolveDataset", release?.contentHash], enabled: Boolean(release), queryFn: ({ signal }) => api.request<HostedTasksetSummary>("resolveDataset", { release }, signal) });
  const guard = useDraftNavigation({ name: "Experiment setup", dirty: JSON.stringify(draft) !== setup.baseline, busy, onLeave: setup.close, retainForDestination(destination) { const next = modelsRouteFromLocation(new URL(destination, window.location.origin)); return Boolean(next && ["datasets", "graders", "experiments"].includes(next.page) && (next.projectId ?? null) === api.projectId); } });
  function reviewTasks() {
    if (!release || !summary.data) return;
    const review = setup.reviewRoute;
    guard.allowNextNavigation();
    navigate(review ? { ...review, detailTab: "tasks", after: null } : { ...route, page: "datasets", resourceId: summary.data.id, datasetKind: "release", revision: release.revision, contentHash: release.contentHash, detailTab: "tasks", collection: "default", executionId: null, passId: null, after: null, query: "" });
  }
  async function save() {
    if (active.current) return; active.current = true; setBusy(true); setError(null);
    try {
      if (!name.trim()) throw new Error("Name this Experiment.");
      if (selectedTarget?.target.kind !== "harness" && graderConflict) throw new Error(graderConflict);
      let request: ModelTasksetRunRequest;
      const scope = project ? { id: project.id, revision: project.revision, contentHash: contentHash(project.content), targetId: selectedTarget?.id ?? null } : undefined;
      if (selectedTarget?.target.kind === "harness") {
        const target = selectedTarget.target;
        const operation = api.operation("prepareHarness", { target, modelId, budget });
        const prepared = await api.request<Prepared>("prepareHarness", { operationId: operation.id, profileRepositoryId: target.profileRepositoryId, definitionId: target.source.definitionId, modelId, maximumCostUsd: budget });
        request = { ...prepared.request, name: name.trim(), ...(scope ? { project: scope } : {}) };
      } else {
        if (selectedTarget?.target.kind === "suite") throw new Error("Choose one released Harness check for this Experiment.");
        if (!population.data || !release) throw new Error("Select a published Dataset version.");
        const tasks = population.data.items.filter(task => setup.selected(release, task.id));
        if (!tasks.length) throw new Error("Select at least one task in the Dataset Tasks table.");
        const members = experimentPopulation({ existing, release, taskIds: tasks.map(task => task.id), seedText: seed, createReceiptId: (taskId, environmentSeed) => `evaluation-${contentHash([api.key, name, release.contentHash, modelId, prompt, taskId, environmentSeed]).slice(0, 32)}` });
        if (!canonicalGraders.length || canonicalGraders.length > 100) throw new Error("Select between one and 100 Dataset graders.");
        if (!models.data?.models.some(model => model.id === modelId)) throw new Error(models.data?.unavailableReason ?? "Choose a supported hosted model.");
        request = { schemaVersion: "openpond.modelTasksetRunRequest.v1", operationId: api.operation("setup", { name, release, modelId, prompt, seed, taskIds: tasks.map(task => task.id) }).id, teamId: api.teamId, modelProjectId: null, name: name.trim(), ...(scope ? { project: scope } : {}), taskset: release, policy: { kind: "hosted_chat", modelId, maxOutputTokens: outputTokens, temperature: 0, topP: 1, ...(prompt.trim() ? { messages: [{ role: "system", content: prompt }] } : {}) }, population: members };
      }
      const submission = { ...(existing ? { id: existing.id } : {}), expectedRevision: existing?.revision ?? 0, request, maximumCostUsd: budget, ...(selectedTarget?.target.kind === "harness" ? {} : { graders: canonicalGraders }) };
      const operation = api.operation("save", submission);
      const saved = await api.request<ExperimentDefinition>("save", SaveExperimentSchema.parse({ ...submission, operationId: operation.id }));
      operation.acknowledge(); guard.allowNextNavigation(); setup.close(); onSaved(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { active.current = false; setBusy(false); }
  }
  return <WorkspacePanel label="Experiment setup" action="experiment"><header><h2>{existing ? "Edit Experiment" : "Create Experiment"}</h2><button type="button" aria-label="Close Experiment setup" disabled={busy} onClick={() => void guard.requestLeave(setup.close)}>×</button></header><form onSubmit={event => { event.preventDefault(); void save(); }}>
    <EvaluationCard title="Dataset"><ReleasedDatasetPicker api={api} value={release} onChange={setup.changeRelease} disabled={selectedTarget?.target.kind === "harness"} />{population.data && release && selectedTarget?.target.kind !== "harness" ? <p>{setup.count(release, population.data.taskCount)} of {population.data.taskCount} tasks selected{setup.selection?.mode !== "subset" && !setup.selection?.ids.length ? " · All tasks in this release" : ""} <button type="button" className="training-text-button" disabled={!summary.data || busy} onClick={reviewTasks}>Review tasks</button></p> : null}</EvaluationCard>
    {population.data && selectedTarget?.target.kind !== "harness" ? <EvaluationCard title="Evaluation"><DatasetSetupGraders graders={population.data.graders} selected={graders} onChange={value => { if (release) patch({ graderChoices: { ...draft.graderChoices, [release.contentHash]: value } }); }} /></EvaluationCard> : null}
    <EvaluationCard title="Model and budget"><label>Model<select value={modelId} onChange={event => patch({ modelId: event.target.value })}><option value="">Choose model</option>{models.data?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>{selectedTarget?.target.kind === "harness" ? <label>Hosted model ID<input value={modelId} onChange={event => patch({ modelId: event.target.value })} required /></label> : null}<label>Whole execution budget ($)<input type="number" min="0.000001" max="10000" step="0.000001" value={budget} onChange={event => patch({ budget: Number(event.target.value) })} required /></label></EvaluationCard>
    <EvaluationCard title="Experiment"><label>Name<input value={name} onChange={event => patch({ name: event.target.value })} required /></label></EvaluationCard>
    <details><summary>Advanced settings</summary>{project?.content.targets.length ? <label>Target<select value={targetId} onChange={event => patch({ targetId: event.target.value })}><option value="model">Hosted model</option>{project.content.targets.map(target => <option key={target.id} value={target.id}>{target.name} · {target.target.kind}</option>)}</select></label> : null}<label>Maximum output tokens<input type="number" min="1" max="4096" value={outputTokens} onChange={event => patch({ outputTokens: Number(event.target.value) })} /></label><label>Environment seeds<input inputMode="text" value={seed} onChange={event => patch({ seed: event.target.value })} /><small>Separate seeds with commas. Unchanged existing membership keeps each original task/seed pair.</small></label><label>System instructions<textarea value={prompt} onChange={event => patch({ prompt: event.target.value })} rows={6} /></label></details>
    <p>Saving pins this Dataset version, selected tasks, and graders. Start creates a separate execution.</p>{graderConflict && selectedTarget?.target.kind !== "harness" ? <p role="alert">{graderConflict}</p> : null}{error || population.error || models.error || summary.error ? <p role="alert">{error ?? population.error?.message ?? models.error?.message ?? summary.error?.message}</p> : null}<button className="training-button" type="submit" disabled={busy || Boolean(graderConflict && selectedTarget?.target.kind !== "harness")}>{busy ? "Validating and saving…" : "Save setup"}</button></form>{guard.dialog}</WorkspacePanel>;
}
