import { useMemo, useState, type FormEvent } from "react";
import type { BaseModelCandidate, BaseModelPreference, ModelProject, Taskset } from "@openpond/contracts";
import type { OpenPondLearningClient } from "openpond-sdk/learning";
import type { ModelProjectConfigurationCheck } from "openpond-sdk/model-projects";
import { AppDialog } from "../dialogs/AppDialog";
import { DropdownSelect } from "../DropdownSelect";
import { X } from "../icons";
import { useDraftNavigation } from "./useDraftNavigation";
import { ModelCreationReward } from "./ModelCreationReward";

export type LabModelCreateInput = {
  id: string;
  name: string;
  description: string | null;
  defaultBaseModel: BaseModelPreference | null;
  tasksetRef: ModelProject["trainingSetup"]["tasksetRef"];
  expectedRevision: number;
};
const STEPS = ["Setup", "Tasks", "Reward"] as const;

export function LabModelCreateDialog({ baseModelCandidates, tasksets, busy: saving, initialName, project = null, learningClient, onClose, onCheck, onCreate, onSaved, onManageModels }: {
  baseModelCandidates: BaseModelCandidate[]; tasksets: Taskset[]; busy: boolean; initialName: string;
  project?: ModelProject | null; learningClient: OpenPondLearningClient | null; onClose: () => void;
  onCheck: (input: LabModelCreateInput) => Promise<ModelProjectConfigurationCheck>;
  onCreate: (input: LabModelCreateInput) => Promise<boolean>; onSaved: () => void; onManageModels: () => void;
}) {
  const listedCandidates = useMemo(() => labModelCreateCandidates(baseModelCandidates), [baseModelCandidates]);
  const [id] = useState(() => project?.id ?? `model_${crypto.randomUUID()}`);
  const [expectedRevision] = useState(project?.revision ?? 0);
  const initial = { name: project?.name ?? initialName, description: project?.objective ?? "", baseModel: project?.trainingSetup.baseModel ?? project?.defaultBaseModel ?? null, tasksetRef: project?.trainingSetup.tasksetRef ?? null, deferTasks: project ? !project.trainingSetup.tasksetRef : false };
  const [draft, setDraft] = useState(initial);
  const [initialSnapshot] = useState(() => JSON.stringify(initial));
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = saving || checking;
  const [checked, setChecked] = useState<{ snapshot: string; report: ModelProjectConfigurationCheck } | null>(null);
  const selectedTaskset = tasksets.find((taskset) => sameTaskset(taskset, draft.tasksetRef)) ?? null;
  const selectedBase = listedCandidates.find((candidate) => JSON.stringify(candidate.preference) === JSON.stringify(draft.baseModel));
  const normalizedName = draft.name.trim().replace(/\s+/g, " ");
  const snapshot = JSON.stringify(draft);
  const patch = (update: Partial<typeof draft>) => { setDraft((current) => ({ ...current, ...update })); setError(null); setChecked(null); };
  const guard = useDraftNavigation({ name: "model setup", dirty: snapshot !== initialSnapshot, busy, onLeave: onClose });
  function checkSetup() {
    if (!normalizedName) return "Name this model.";
    if (!draft.deferTasks && !selectedTaskset) return "Choose an available Taskset release, or explicitly add tasks later.";
    if (draft.baseModel && (!selectedBase || !selectedBase.available)) return "The selected starting model is unavailable. Choose an available model or choose later.";
    if (selectedTaskset && !selectedTaskset.tasks.length && !selectedTaskset.datasetArtifact) return "The selected Taskset has no tasks or dataset artifact.";
    return null;
  }
  function configuration(): LabModelCreateInput {
    return { id, name: normalizedName, description: draft.description.trim() || null, defaultBaseModel: draft.baseModel, tasksetRef: draft.deferTasks ? null : draft.tasksetRef, expectedRevision };
  }
  async function checkConfiguration(): Promise<boolean> {
    const problem = checkSetup();
    setChecked(null);
    setError(problem);
    if (problem) return false;
    setChecking(true);
    try {
      const report = await onCheck(configuration());
      setChecked({ snapshot, report });
      return report.canSave;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The execution owner could not check this configuration.");
      return false;
    } finally { setChecking(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (step < 2) { if (step === 0 && !normalizedName) setError("Name this model."); else if (step === 1 && !draft.deferTasks && !selectedTaskset) setError("Choose a Taskset or add tasks later."); else { setError(null); setStep(step + 1); } return; }
    if (!await checkConfiguration()) return;
    const created = await onCreate(configuration());
    if (!created) setError("The configuration could not be saved. Your edits remain here; check the reported error and retry.");
    else { guard.allowNextNavigation(); onSaved(); }
  }
  return <>
    <AppDialog ariaLabel={project ? "Edit model" : "New model"} backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-model-create-dialog" dismissDisabled={busy} initialFocusKey={id} onClose={() => { void guard.requestLeave(onClose); }}>
      <header><div><h2>{project ? "Edit model" : "New model"}</h2><p>Choose the model’s purpose, tasks and quality checks. Training starts separately from Runs.</p></div><button aria-label="Close model setup" disabled={busy} type="button" onClick={() => { void guard.requestLeave(onClose); }}><X size={16} /></button></header>
      <nav className="model-create-steps" aria-label="Model setup steps">{STEPS.map((label, index) => <button type="button" key={label} disabled={busy || (!project && index > step)} aria-current={step === index ? "step" : undefined} onClick={() => { setStep(index); setError(null); }}>{index + 1}. {label}</button>)}</nav>
      <form onSubmit={(event) => { void submit(event); }}>
        <fieldset disabled={busy} className="model-create-fields">
          {step === 0 ? <>
            <label><span>Name</span><input data-autofocus maxLength={200} value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
            <label><span>Purpose</span><textarea maxLength={5000} rows={3} placeholder="What should this model do well?" value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label>
            <div className="labs-model-create-field"><span>Starting model</span><div className="labs-model-create-select-row"><DropdownSelect label="Starting model" value={selectedBase?.selectionKey ?? ""} options={[{ value: "", label: draft.baseModel && !selectedBase ? `${draft.baseModel.modelId} · unavailable` : "Choose later" }, ...listedCandidates.map((candidate) => ({ value: candidate.selectionKey, label: `${candidate.label} · ${candidate.sourceLabel}${candidate.available ? "" : " · Unavailable"}`, disabled: !candidate.available }))]} onChange={(key) => patch({ baseModel: listedCandidates.find((candidate) => candidate.selectionKey === key)?.preference ?? null })} /><button aria-label="Manage starting models" className="labs-model-create-add" title="Manage models in Compute settings" type="button" onClick={() => { void guard.requestLeave(onManageModels); }}>+</button></div></div>
          </> : step === 1 ? <>
            <label><span>Taskset</span><select disabled={draft.deferTasks} value={selectedTaskset ? tasksetKey(selectedTaskset) : ""} onChange={(event) => { const taskset = tasksets.find((taskset) => tasksetKey(taskset) === event.target.value); patch({ tasksetRef: taskset ? { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } : null }); }}><option value="">Choose a Taskset</option>{tasksets.map((taskset) => <option key={tasksetKey(taskset)} value={tasksetKey(taskset)}>{taskset.name} · release {taskset.revision}</option>)}</select></label>
            <label className="model-create-checkbox"><input type="checkbox" checked={draft.deferTasks} onChange={(event) => patch({ deferTasks: event.target.checked })} /><span>Add tasks later · save as a draft</span></label>
            {!draft.deferTasks && selectedTaskset ? <><p>{selectedTaskset.tasks.length || selectedTaskset.datasetArtifact?.rowCount || 0} tasks · {selectedTaskset.objective}</p>{selectedTaskset.tasks[0] ? <details><summary>Example task</summary><pre>{JSON.stringify({ input: selectedTaskset.tasks[0].input, expectedOutput: selectedTaskset.tasks[0].expectedOutput }, null, 2)}</pre></details> : null}</> : !tasksets.length ? <p>Create or import a Taskset from Tasksets, then select its published release here.</p> : null}
          </> : <>
            {draft.deferTasks ? <p>This model will remain a draft. Attach a Taskset to configure its Rewards.</p> : selectedTaskset ? <ModelCreationReward client={learningClient} taskset={selectedTaskset} /> : <p>Return to Tasks and select an available release.</p>}
            <button type="button" className="training-button secondary" onClick={() => { void checkConfiguration(); }}>{checking ? "Checking…" : "Check setup"}</button>
            {checked?.snapshot === snapshot ? <div role="status">
              <p>{checked.report.canSave ? checked.report.deferred.length ? "Draft configuration checked by the execution owner. Deferred choices remain available for later setup." : "Configuration checked by the execution owner. Training readiness and Reward quality are checked separately." : "Resolve these setup issues before saving."}</p>
              {checked.report.findings.some((finding) => finding.severity === "error") ? <ul>{checked.report.findings.filter((finding) => finding.severity === "error").map((finding, index) => <li key={`${finding.code}:${index}`}>{finding.message}</li>)}</ul> : null}
              {checked.report.findings.some((finding) => finding.severity === "warning") ? <details><summary>Setup notes</summary><ul>{checked.report.findings.filter((finding) => finding.severity === "warning").map((finding, index) => <li key={`${finding.code}:${index}`}>{finding.message}</li>)}</ul></details> : null}
            </div> : null}
          </>}
        </fieldset>
        {error ? <div className="labs-rename-error" role="alert">{error}</div> : null}
        <footer><button disabled={busy} type="button" onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button>{step > 0 ? <button disabled={busy} type="button" onClick={() => { setStep(step - 1); setError(null); }}>Back</button> : null}<button disabled={busy || !normalizedName} type="submit">{checking ? "Checking…" : saving ? "Saving…" : step < 2 ? "Continue" : project ? "Save changes" : "Create model"}</button></footer>
      </form>
    </AppDialog>
    {guard.dialog}
  </>;
}
export function labModelCreateCandidates(candidates: BaseModelCandidate[]): BaseModelCandidate[] { return candidates.filter((candidate) => !(candidate.preference.source === "builtin" && candidate.nonProduction)); }
function tasksetKey(taskset: Taskset) { return `${taskset.id}:${taskset.revision}:${taskset.contentHash}`; }
function sameTaskset(taskset: Taskset, ref: ModelProject["trainingSetup"]["tasksetRef"]) { return ref && taskset.id === ref.id && taskset.revision === ref.revision && taskset.contentHash === ref.contentHash; }
