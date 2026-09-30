import { EvaluationCard } from "./EvaluationPresentation";
import { DatasetSetupGraders, type SelectedDatasetGrader } from "./DatasetSetupGraders";
import { ReleasedDatasetPicker } from "./ReleasedDatasetPicker";
import { useDatasetPopulation } from "./useDatasetPopulation";
import { WorkspacePanel } from "./WorkspacePanel";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { contentHash } from "@openpond/harness";
import { SaveExperimentSchema, type ExperimentDefinition, type PreparedHarnessExperimentSchema } from "openpond-sdk/experiments";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { ModelTasksetRunRequest } from "openpond-sdk/model-taskset-runs";
import type { z } from "zod";
import type { Inventory, WorkspaceApi } from "./workspace-api";
type Prepared = z.infer<typeof PreparedHarnessExperimentSchema>;
export function ExperimentSetupPanel({ api, inventory, existing, onClose, onSaved }: { api: WorkspaceApi; inventory: Inventory | null; existing: ExperimentDefinition | null; onClose: () => void; onSaved: (value: ExperimentDefinition) => void }) {
  const [name, setName] = useState(existing?.request.name ?? "");
  const [release, setRelease] = useState<DatasetPopulationPage["release"] | null>(existing?.request.taskset ?? null);
  const [modelId, setModelId] = useState(existing?.request.policy && "modelId" in existing.request.policy ? existing.request.policy.modelId : "");
  const [budget, setBudget] = useState(existing?.maximumCostUsd ?? 1);
  const [outputTokens, setOutputTokens] = useState(existing?.request.policy.kind === "hosted_chat" ? existing.request.policy.maxOutputTokens : 1024);
  const [prompt, setPrompt] = useState(existing?.request.policy.kind === "hosted_chat" ? existing.request.policy.messages?.find(message => message.role === "system")?.content ?? "" : "");
  const project = inventory?.projects.projects.find(item => item.id === api.projectId);
  const [targetId, setTargetId] = useState(existing?.request.project?.targetId ?? project?.content.defaultTargetId ?? "model");
  const selectedTarget = project?.content.targets.find(target => target.id === targetId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const population = useDatasetPopulation(api, release);
  const [graderChoices, setGraderChoices] = useState<Record<string, SelectedDatasetGrader[]>>({});
  const graders = release ? graderChoices[release.contentHash] ?? (existing?.request.taskset.contentHash === release.contentHash ? existing.graders.map(grader => ({ id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: grader.mappings ?? [] })) : population.data && population.data.graders.length <= 100 ? population.data.graders.map(grader => ({ id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: [] })) : []) : [];
  const models = useQuery({ queryKey: ["evaluation-workspace", api.key, "modelChoices", release?.contentHash], enabled: Boolean(release), queryFn: ({ signal }) => api.request<{ available: boolean; unavailableReason: string | null; models: Array<{ id: string; name: string }> }>("modelChoices", { taskset: release }, signal) });
  async function save() {
    if (active.current) return; active.current = true; setBusy(true); setError(null);
    try {
      if (!name.trim()) throw new Error("Name this Experiment.");
      let request: ModelTasksetRunRequest;
      const scope = project ? { id: project.id, revision: project.revision, contentHash: contentHash(project.content), targetId: selectedTarget?.id ?? null } : undefined;
      if (selectedTarget?.target.kind === "harness") {
        const target = selectedTarget.target;
        const operation = api.operation("prepareHarness", { target, modelId, budget });
        const prepared = await api.request<Prepared>("prepareHarness", { operationId: operation.id, profileRepositoryId: target.profileRepositoryId, definitionId: target.source.definitionId, modelId, maximumCostUsd: budget });
        request = { ...prepared.request, name: name.trim(), ...(scope ? { project: scope } : {}) };
      } else {
        if (selectedTarget?.target.kind === "suite") throw new Error("Choose one released Harness check for this Experiment.");
        if (!population.data || !release) throw new Error("Select a published dataset version.");
        if (!graders.length || graders.length > 100) throw new Error("Select between one and 100 Dataset graders.");
        if (!models.data?.models.some(model => model.id === modelId)) throw new Error(models.data?.unavailableReason ?? "Choose a supported hosted model.");
        request = { schemaVersion: "openpond.modelTasksetRunRequest.v1", operationId: api.operation("setup", { name, release, modelId, prompt }).id, teamId: api.teamId, modelProjectId: null, name: name.trim(), ...(scope ? { project: scope } : {}), taskset: release, policy: { kind: "hosted_chat", modelId, maxOutputTokens: outputTokens, temperature: 0, topP: 1, ...(prompt.trim() ? { messages: [{ role: "system", content: prompt }] } : {}) }, population: population.data.items.map(task => ({ receiptId: `evaluation-${contentHash([api.key, name, release.contentHash, modelId, prompt, task.id, "0"]).slice(0, 32)}`, taskId: task.id, split: task.split, seed: "0", fixtureId: null })) };
      }
      const submission = { ...(existing ? { id: existing.id } : {}), expectedRevision: existing?.revision ?? 0, request, maximumCostUsd: budget, ...(selectedTarget?.target.kind === "harness" ? {} : { graders }) };
      const operation = api.operation("save", submission);
      const value = SaveExperimentSchema.parse({ ...submission, operationId: operation.id });
      const saved = await api.request<ExperimentDefinition>("save", value);
      operation.acknowledge(); onSaved(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { active.current = false; setBusy(false); }
  }
  return <WorkspacePanel label="Experiment setup" action="experiment"><header><h2>{existing ? "Edit Experiment" : "Create Experiment"}</h2><button disabled={busy} onClick={onClose}>Close</button></header><form onSubmit={event => { event.preventDefault(); void save(); }}><EvaluationCard title="Experiment"><label>Name<input value={name} onChange={event => setName(event.target.value)} required /></label></EvaluationCard><EvaluationCard title="Target and dataset"><label>Target<select value={targetId} onChange={event => setTargetId(event.target.value)}><option value="model">Hosted model</option>{project?.content.targets.map(target => <option key={target.id} value={target.id}>{target.name} · {target.target.kind}</option>)}</select></label><ReleasedDatasetPicker api={api} value={release} onChange={setRelease} disabled={selectedTarget?.target.kind === "harness"} />{population.data && selectedTarget?.target.kind !== "harness" ? <DatasetSetupGraders graders={population.data.graders} selected={graders} onChange={value => { if (release) setGraderChoices(previous => ({ ...previous, [release.contentHash]: value })); }} /> : null}</EvaluationCard><EvaluationCard title="Model and instructions"><label>Model<select value={modelId} onChange={event => setModelId(event.target.value)}><option value="">Choose model</option>{models.data?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>{selectedTarget?.target.kind === "harness" ? <label>Hosted model ID<input value={modelId} onChange={event => setModelId(event.target.value)} required /></label> : null}<label>Maximum output tokens<input type="number" min="1" max="4096" value={outputTokens} onChange={event => setOutputTokens(Number(event.target.value))} /></label><label>System instructions<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={6} /></label></EvaluationCard><EvaluationCard title="Execution budget"><label>Whole execution budget ($)<input type="number" min="0.000001" max="10000" step="0.000001" value={budget} onChange={event => setBudget(Number(event.target.value))} required /></label><p>Saving retains exact dataset and grader releases. Start is a separate action.</p></EvaluationCard>{error || population.error || models.error ? <p role="alert">{error ?? population.error?.message ?? models.error?.message}</p> : null}<button className="training-button" type="submit" disabled={busy}>{busy ? "Validating and saving…" : "Save setup"}</button></form></WorkspacePanel>;
}
