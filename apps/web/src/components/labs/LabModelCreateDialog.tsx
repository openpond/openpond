import { useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { BaseModelCandidate, BaseModelPreference, ModelProject, Taskset } from "@openpond/contracts";
import type { OpenPondLearningClient } from "openpond-sdk/learning";
import type { ModelProjectConfigurationCheck } from "openpond-sdk/model-projects";
import type { ModelStarterCreationRequest } from "openpond-sdk/model-starters";
import type { ModelStarterPreview } from "../../hooks/useTraining";
import { AppDialog } from "../dialogs/AppDialog";
import { DropdownSelect } from "../DropdownSelect";
import { CheckCircle2, X } from "../icons";
import { useDraftNavigation, type DraftEditorHandle } from "./useDraftNavigation";
import { ModelCreationReward } from "./ModelCreationReward";
import { ModelTrainingSettings, modelTrainingSettingsProblem } from "./ModelTrainingSettings";
import type { TasksetDraftEditorHandle } from "../datasets/TasksetDraftEditor";

export type LabModelCreateInput = {
  starterRequest?: ModelStarterCreationRequest;
  id: string;
  name: string;
  description: string | null;
  defaultBaseModel: BaseModelPreference | null;
  tasksetRef: ModelProject["trainingSetup"]["tasksetRef"];
  expectedRevision: number;
  rewardBindingRef: ModelProject["trainingSetup"]["rewardBindingRef"];
  recipe: ModelProject["trainingSetup"]["recipe"];
};
const STEPS = ["Model", "Tasks", "Grader", "Learning"] as const;

export function LabModelCreateDialog({ baseModelCandidates, tasksets, busy: saving, initialName, project = null, starter = null, learningClient, onClose, onCheck, onCreate, onSaved, onManageModels, renderTasksetBuilder }: {
  starter?: { preview: ModelStarterPreview; profileId: string } | null;
  renderTasksetBuilder: (onPublished: (id: string) => void, onClose: () => void, closeRef: Ref<TasksetDraftEditorHandle>) => ReactNode;
  baseModelCandidates: BaseModelCandidate[]; tasksets: Taskset[]; busy: boolean; initialName: string;
  project?: ModelProject | null; learningClient: OpenPondLearningClient | null; onClose: () => void;
  onCheck: (input: LabModelCreateInput) => Promise<ModelProjectConfigurationCheck>;
  onCreate: (input: LabModelCreateInput) => Promise<boolean>; onSaved: () => void; onManageModels: () => void;
}) {
  const listedCandidates = useMemo(() => labModelCreateCandidates(baseModelCandidates), [baseModelCandidates]);
  const [id] = useState(() => project?.id ?? `model_${crypto.randomUUID()}`);
  const [expectedRevision] = useState(project?.revision ?? 0);
  const activeStarter = starter;
  const [operationId] = useState(() => `starter-create:${crypto.randomUUID()}`);
  const [pendingRequest, setPendingRequest] = useState<ModelStarterCreationRequest | null>(null);
  const initial = { name: project?.name ?? starter?.preview.starter.name ?? initialName, description: project?.objective ?? starter?.preview.starter.description ?? "", baseModel: project?.trainingSetup.baseModel ?? project?.defaultBaseModel ?? starter?.preview.starter.startingModel ?? null, tasksetRef: project?.trainingSetup.tasksetRef ?? null, rewardBindingRef: project?.trainingSetup.rewardBindingRef ?? starter?.preview.starter.rewardBinding ?? null };
  const [draft, setDraft] = useState({ ...initial, recipe: project?.trainingSetup.recipe ?? null });
  const [initialSnapshot] = useState(() => JSON.stringify({ ...initial, recipe: project?.trainingSetup.recipe ?? null }));
  const [step, setStep] = useState(0);
  const [addingTasks, setAddingTasks] = useState(false);
  const tasksetEditor = useRef<TasksetDraftEditorHandle>(null);
  const rewardEditor = useRef<DraftEditorHandle>(null);
  const [rewardEditing, setRewardEditing] = useState<"reward" | "combined" | null>(null);
  const [publishedTasksetId, setPublishedTasksetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = saving || checking;
  const fieldsLocked = busy || pendingRequest !== null;
  const [checked, setChecked] = useState<{ snapshot: string; report: ModelProjectConfigurationCheck } | null>(null);
  const selectedTaskset = tasksets.find((taskset) => publishedTasksetId ? taskset.id === publishedTasksetId : sameTaskset(taskset, draft.tasksetRef)) ?? null;
  const selectedBase = listedCandidates.find((candidate) => JSON.stringify(candidate.preference) === JSON.stringify(draft.baseModel));
  const normalizedName = draft.name.trim().replace(/\s+/g, " ");
  const snapshot = JSON.stringify(draft);
  const patch = (update: Partial<typeof draft>) => { setDraft((current) => {
    const sourceChanged = (["baseModel", "tasksetRef", "rewardBindingRef"] as const)
      .some(key => key in update && JSON.stringify(update[key]) !== JSON.stringify(current[key]));
    return { ...current, ...update, recipe: sourceChanged ? null : "recipe" in update ? update.recipe ?? null : current.recipe };
  }); setError(null); setChecked(null); };
  const guard = useDraftNavigation({ name: "model setup", dirty: snapshot !== initialSnapshot || publishedTasksetId !== null || pendingRequest !== null, busy, onLeave: onClose });
  function checkSetup() {
    if (pendingRequest) return null;
    if (!normalizedName) return "Name this model.";
    const settingsProblem = modelTrainingSettingsProblem(draft.recipe);
    if (settingsProblem) return settingsProblem;
    if (activeStarter && !draft.baseModel) return "Choose a starting model for this starter.";
    if (draft.tasksetRef && !selectedTaskset) return "The selected Taskset is unavailable. Choose another Taskset or clear the selection.";
    if (draft.baseModel && (!selectedBase || !selectedBase.available)) return "The selected starting model is unavailable. Choose an available model or choose later.";
    if (selectedTaskset && !selectedTaskset.tasks.length && !selectedTaskset.datasetArtifact) return "The selected Taskset has no tasks or dataset artifact.";
    return null;
  }
  function configuration(): LabModelCreateInput {
    const starterRequest = pendingRequest ?? (activeStarter && draft.baseModel ? { schemaVersion: "openpond.modelStarterCreation.v1" as const, operationId, profileId: activeStarter.profileId, modelId: id, name: normalizedName, starter: { id: activeStarter.preview.starter.id, revision: activeStarter.preview.starter.revision, contentHash: activeStarter.preview.starter.contentHash }, startingModel: draft.baseModel, method: activeStarter.preview.starter.defaultMethod, rewardBindingRef: activeStarter.preview.starter.rewardBinding } : undefined);
    return { starterRequest, id, name: normalizedName, description: draft.description.trim() || null, defaultBaseModel: draft.baseModel, tasksetRef: selectedTaskset ? { id: selectedTaskset.id, revision: selectedTaskset.revision, contentHash: selectedTaskset.contentHash } : draft.tasksetRef, rewardBindingRef: draft.rewardBindingRef, recipe: draft.recipe, expectedRevision };
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
    if (step < 3) { if (step === 0 && !normalizedName) setError("Name this model."); else { setError(null); setStep(step + 1); } return; }
    if (!await checkConfiguration()) return;
    const input = configuration();
    if (input.starterRequest) setPendingRequest(input.starterRequest);
    try {
      const created = await onCreate(input);
      if (!created) setError(input.starterRequest ? "Creation was not confirmed. Retry this same request to retrieve its saved result; the model may already have been created." : "The configuration could not be saved. Your edits remain here; check the reported error and retry.");
      else { guard.allowNextNavigation(); onSaved(); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Creation was not confirmed. Retry the same request."); }
  }
  const rewardControl = <ModelCreationReward client={learningClient} taskset={selectedTaskset} starter={activeStarter?.preview}
    bindingRef={draft.rewardBindingRef} onChange={rewardBindingRef => patch({ rewardBindingRef })}
    editor={rewardEditing} onEditorChange={setRewardEditing} closeRef={rewardEditor} />;
  return <>
    {!addingTasks ? <AppDialog ariaLabel={rewardEditing ? rewardEditing === "reward" ? "Create grader" : "Combine graders" : project ? "Edit model" : "New model"} backdropClassName="labs-rename-backdrop" className={rewardEditing ? "labs-rename-dialog labs-model-taskset-dialog" : "labs-rename-dialog labs-model-create-dialog"} dismissDisabled={busy} initialFocusKey={`${id}:${rewardEditing ?? step}`} onClose={() => { if (rewardEditing) rewardEditor.current?.requestClose(); else void guard.requestLeave(onClose); }}>
      {rewardEditing ? rewardControl : <>
      <header><div><h2>{project ? "Edit model" : "New model"}</h2><p>{activeStarter ? "Choose a starting model and review the example’s Taskset and grader." : "Choose a starting model, tasks and a grader. You can skip tasks and import them later."}</p></div><button aria-label="Close model setup" disabled={busy} type="button" onClick={() => { void guard.requestLeave(onClose); }}><X size={16} /></button></header>
      <nav className="model-create-steps" aria-label="Model setup steps">{STEPS.map((label, index) => <button type="button" key={label} disabled={fieldsLocked || (!project && index > step)} aria-current={step === index ? "step" : undefined} onClick={() => { setStep(index); setError(null); }}>{label}</button>)}</nav>
      <form onSubmit={(event) => { void submit(event); }}>
        <fieldset disabled={fieldsLocked} className="model-create-fields">
          {step === 0 ? <>
            <label><span>Name</span><input data-autofocus maxLength={200} value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
            <div className="labs-model-create-field"><span>Starting model</span><div className="labs-model-create-select-row"><DropdownSelect floating label="Starting model" value={selectedBase?.selectionKey ?? ""} options={[{ value: "", label: draft.baseModel && !selectedBase ? `${draft.baseModel.modelId} · unavailable` : "Choose later" }, ...listedCandidates.map((candidate) => ({ value: candidate.selectionKey, label: `${candidate.label} · ${candidate.sourceLabel}${candidate.available ? "" : " · Unavailable"}`, disabled: !candidate.available }))]} onChange={(key) => patch({ baseModel: listedCandidates.find((candidate) => candidate.selectionKey === key)?.preference ?? null })} /><button aria-label="Manage starting models" className="labs-model-create-add" title="Manage models in Compute settings" type="button" onClick={() => { void guard.requestLeave(onManageModels); }}>+</button></div></div>
            <ModelTrainingSettings recipe={draft.recipe} onChange={recipe => patch({ recipe })} />
          </> : step === 1 && activeStarter ? <>
            <div className="labs-model-create-field"><span>Taskset</span><div className="labs-model-create-select-row"><select aria-label="Taskset" disabled value={activeStarter.preview.starter.taskset.id}><option value={activeStarter.preview.starter.taskset.id}>{activeStarter.preview.starter.name}</option></select></div></div>
            <p>{activeStarter.preview.counts.train} training tasks · {activeStarter.preview.counts.validation} validation tasks · {activeStarter.preview.counts.frozenEvaluation} held-out evaluation tasks</p>
            {activeStarter.preview.tasks.map(task => <details key={task.id}><summary>Example task</summary><pre>{JSON.stringify(task.input, null, 2)}</pre></details>)}
            <details><summary>Expected output format</summary><pre>{JSON.stringify(activeStarter.preview.outputSchema, null, 2)}</pre></details>
          </> : step === 1 ? <>
            <div className="labs-model-create-field"><span>Taskset</span><div className="labs-model-create-select-row"><select aria-label="Taskset" value={selectedTaskset ? tasksetKey(selectedTaskset) : ""} onChange={(event) => { setPublishedTasksetId(null); const taskset = tasksets.find((taskset) => tasksetKey(taskset) === event.target.value); patch({ tasksetRef: taskset ? { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } : null }); }}><option value="">Choose a Taskset</option>{tasksets.map((taskset) => <option key={tasksetKey(taskset)} value={tasksetKey(taskset)}>{taskset.name} · release {taskset.revision}</option>)}</select><button type="button" aria-label="Create or import Taskset" className="labs-model-create-add" onClick={() => setAddingTasks(true)}>+</button></div></div>
            {selectedTaskset ? <><p>{selectedTaskset.tasks.length || selectedTaskset.datasetArtifact?.rowCount || 0} tasks · {selectedTaskset.objective}</p>{selectedTaskset.tasks[0] ? <details><summary>Example task</summary><pre>{JSON.stringify({ input: selectedTaskset.tasks[0].input, expectedOutput: selectedTaskset.tasks[0].expectedOutput }, null, 2)}</pre></details> : null}</> : !tasksets.length ? <p>Create or import a Taskset from Tasksets, then select its published release here.</p> : null}
          </> : step === 2 ? <>
            {rewardControl}
          </> : <section className="model-create-learning"><h3>Continual learning</h3><p>Use approved feedback and corrected answers in future model updates.</p><p>{project?.hosted ? "After saving, open Learning settings on this model to choose task sources, the minimum new examples, an update interval and spending limits. Your current learning policy stays in place." : "After saving, connect this model to a hosted team from its model page, then configure task sources, the minimum new examples, an update interval and spending limits."}</p><p>You can also start updates manually from Runs.</p></section>}
          {step >= 2 ? <>
            <button type="button" className="training-button secondary" onClick={() => { void checkConfiguration(); }}>{checking ? "Checking…" : "Check setup"}</button>
            {checked?.snapshot === snapshot ? <div role="status">
              {checked.report.canSave ? <p className="model-setup-checked"><CheckCircle2 size={16} aria-hidden="true" /> Setup checked</p> : null}
              <p>{checked.report.canSave ? checked.report.deferred.length ? "Configuration checked. You can attach tasks and finish the remaining choices later." : "Configuration checked by the execution owner. Training readiness and Grader quality are checked separately." : "Resolve these setup issues before saving."}</p>
              {checked.report.findings.some((finding) => finding.severity === "error") ? <ul>{checked.report.findings.filter((finding) => finding.severity === "error").map((finding, index) => <li key={`${finding.code}:${index}`}>{finding.message}</li>)}</ul> : null}
              {checked.report.findings.some((finding) => finding.severity === "warning") ? <details><summary>Setup notes</summary><ul>{checked.report.findings.filter((finding) => finding.severity === "warning").map((finding, index) => <li key={`${finding.code}:${index}`}>{finding.message}</li>)}</ul></details> : null}
            </div> : null}
          </> : null}
        </fieldset>
        {error ? <div className="labs-rename-error" role="alert">{error}</div> : null}
        <footer><button disabled={busy} type="button" onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button>{step > 0 ? <button disabled={fieldsLocked} type="button" onClick={() => { setStep(step - 1); setError(null); }}>Back</button> : null}<button disabled={busy || !normalizedName} type="submit">{checking ? "Checking…" : saving ? "Saving…" : pendingRequest ? "Retry creation" : step === 1 && !selectedTaskset && !activeStarter ? "Skip" : step < 3 ? "Continue" : project ? "Save changes" : "Create model"}</button></footer>
      </form>
      </>}
    </AppDialog> : null}
    {addingTasks ? <AppDialog ariaLabel="Create or import Taskset" className="labs-rename-dialog labs-model-taskset-dialog" backdropClassName="labs-rename-backdrop" onClose={() => tasksetEditor.current?.requestClose()}>{renderTasksetBuilder((tasksetId) => { setPublishedTasksetId(tasksetId); patch({ recipe: null }); const taskset = tasksets.find((item) => item.id === tasksetId); if (taskset) patch({ tasksetRef: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } }); setAddingTasks(false); }, () => setAddingTasks(false), tasksetEditor)}</AppDialog> : null}
    {guard.dialog}
  </>;
}
export function labModelCreateCandidates(candidates: BaseModelCandidate[]): BaseModelCandidate[] { return candidates.filter((candidate) => !(candidate.preference.source === "builtin" && candidate.nonProduction)); }
function tasksetKey(taskset: Taskset) { return `${taskset.id}:${taskset.revision}:${taskset.contentHash}`; }
function sameTaskset(taskset: Taskset, ref: ModelProject["trainingSetup"]["tasksetRef"]) { return ref && taskset.id === ref.id && taskset.revision === ref.revision && taskset.contentHash === ref.contentHash; }
