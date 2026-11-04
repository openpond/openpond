import { useEffect, useRef, useState } from "react";
import { canonicalJson, ExperimentDraftSchema, experimentOperationLabel, type ActivationExperimentFormDraft, type ExperimentDraft } from "openpond-sdk/training";
import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
import { useDraftNavigation } from "../useDraftNavigation";
import { modelsRouteFromLocation } from "../models-route";
import { EvaluationCard } from "./EvaluationPresentation";
import { ExperimentTypeControl } from "./ExperimentTypeControl";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useExperimentSetupTransition } from "./useExperimentSetupTransition";
import { useTrainingExperimentInputs } from "./useTrainingExperimentInputs";
import { useModelModificationCapabilities } from "./useModelModificationCapabilities";
import { WorkspacePanel } from "./WorkspacePanel";
import type { WorkspaceApi } from "./workspace-api";

import { useManagedActivationExperiment } from "./useManagedActivationExperiment";
import { ManagedActivationExecution } from "./ManagedActivationExecution";
import { initialActivationForm } from "./activation-form-defaults";

type Method = "neuron_steering" | "inspect_activations";


/** The ordinary experiment authoring owner. Runtime admission is deliberately
 * separate: a catalog model choice does not attest a loaded tensor identity. */
export function ActivationExperimentSetupPanel({ api, method, visible, onClose, onSaveDraft }: {
  api: WorkspaceApi; method: Method; visible: boolean; onClose: () => void;
  onSaveDraft?: (draft: ExperimentDraft) => Promise<unknown>;
}) {
  const setup = useEvaluationSetup(), seed = setup.initialExperiment?.operationType === method ? setup.initialExperiment : null;
  const [form, setForm] = useState<ActivationExperimentFormDraft>(() => seed?.activationForm ?? initialActivationForm());
  const [name, setName] = useState(seed?.name ?? experimentOperationLabel(method));
  const [savingBusy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const inputs = useTrainingExperimentInputs(api, visible, null);
  const capabilities = useModelModificationCapabilities(api, setup.startingModel?.source === "trained" || setup.startingModel?.source === "engram" ? null : setup.trainingBaseModel, visible);
  const execution = capabilities.current?.methods.find(row => row.method === method)?.execution;
  const owner = useManagedActivationExperiment(api, {draftId:setup.initialExperiment?.id??null,method,visible});
  const activeExecution = owner.selectedId && !['completed','failed','cancelled'].includes(owner.execution?.phase ?? owner.receipt?.execution.phase ?? 'prepared');
  const busy = savingBusy || owner.busy;
  const locked = busy || Boolean(owner.original) || Boolean(activeExecution);
  const snapshot = canonicalJson({ ...form, baseModel: setup.trainingBaseModel, name, startingModel: setup.startingModel });
  const baseline = useRef(snapshot), saving = useRef(false);
  const scope = canonicalJson([api.key, api.connection.serverUrl, api.actorId, setup.initialExperiment?.id]);
  const active = useRef(scope);
  useEffect(() => { active.current = scope; return () => { active.current = "unmounted"; }; }, [scope]);
  const dirty = snapshot !== baseline.current, reportDirty = setup.reportOperationDraftDirty;
  useEffect(() => { reportDirty(method, dirty); }, [reportDirty, method, dirty]);
  const guard = useDraftNavigation({ name: "experiment setup", dirty: dirty || setup.operationDraftDirty || setup.evaluationDirty, busy, onLeave: onClose,
    retainForDestination(destination) {
      const route = modelsRouteFromLocation(new URL(destination, window.location.origin));
      return Boolean(route && ["datasets", "graders", "experiments"].includes(route.page)
        && (route.collection !== "drafts" || route.resourceId === setup.initialExperiment?.id)
        && (route.projectId ?? null) === api.projectId);
    },
  });
  useExperimentSetupTransition(guard, visible);
  const patch = (value: Partial<ActivationExperimentFormDraft>) => setForm(current => ({ ...current, ...value }));
  const modelValue = setup.startingModel?.source === "engram" ? `engram:${setup.startingModel.engram.versionHash}` : setup.startingModel?.source === "steering" ? `steering:${setup.startingModel.steering.versionHash}` : setup.startingModel?.source === "trained" ? `trained:${setup.startingModel.trainedVersion.contentHash}`
    : setup.trainingBaseModel ? canonicalJson(setup.trainingBaseModel) : "";
  const models = inputs.models.map(item => ({ value: canonicalJson(item.preference), label: item.name }));
  const coordinateFields: Array<"layer" | "neuron" | "dose"> = method === "neuron_steering" ? ["layer", "neuron", "dose"] : ["layer", "neuron"];
  if (modelValue && !models.some(item => item.value === modelValue))
    models.unshift({ value: modelValue, label: setup.startingModel?.label ?? setup.trainingBaseModel!.modelId });
  function draftSnapshot() {
    if (!setup.initialExperiment) throw new Error("Open the experiment before saving.");
    return ExperimentDraftSchema.parse({ schemaVersion: "openpond.experimentDraft.v1", id: setup.initialExperiment.id,
      operationType: method, name: name.trim() || experimentOperationLabel(method),
      ...(setup.startingModel ? {startingModel:setup.startingModel} : {}), activationForm:{...form,baseModel:setup.trainingBaseModel,maximumSpendUsd:form.maximumSpendUsd??""} });
  }
  async function saveSnapshot(draft:ExperimentDraft) {
    if (!onSaveDraft) throw new Error("Load canonical draft storage before preparing.");
    await onSaveDraft(draft);
    if (active.current !== scope) throw new Error("Return to the original experiment account before continuing.");
    baseline.current = snapshot;
  }
  async function run() {setError(null);try {await owner.prepare(draftSnapshot(),saveSnapshot);} catch(cause){setError(cause);}}
  async function save() {
    if (!onSaveDraft || !setup.initialExperiment || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      await saveSnapshot(draftSnapshot());
      if (active.current !== scope) return;
      baseline.current = snapshot;
    } catch (cause) { if (active.current === scope) setError(cause); }
    finally { saving.current = false; if (active.current === scope) setBusy(false); }
  }
  return <WorkspacePanel label="Experiment setup" action="experiment" onRequestClose={() => void guard.requestLeave(onClose)}>
    <header><h2>Run Experiment</h2><button type="button" disabled={busy} onClick={() => void guard.requestLeave(onClose)}>Close setup</button></header>
    <form noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
      <EvaluationCard title="Starting model"><fieldset disabled={locked}>
        <label>Model<DropdownSelect label="Starting model" floating searchable value={modelValue} disabled={inputs.isPending && !modelValue}
          options={[{ value: "", label: inputs.isPending ? "Loading models…" : inputs.isSuccess && !models.length ? "No catalog models available" : "Choose model", disabled: inputs.isPending || inputs.isSuccess && !models.length }, ...models]}
          onChange={value => {
            if (value === modelValue) return;
            const selected = inputs.models.find(item => canonicalJson(item.preference) === value);
            if (value && !selected) { setError("Refresh the model list before changing this selection."); return; }
            setup.setTrainingBaseModel(selected?.preference ?? null);
            setForm(({startingProfile: _source, ...current}) => current);
          }} /></label>
        <ExperimentTypeControl disabled={locked} />
        <p>Run compiles and prepares this exact saved configuration. Review the immutable plan before explicitly starting paid execution.</p>
        {execution ? <p>{execution.state === "unavailable" ? execution.reason : "A compatible activation runtime is available. Preparation rechecks its exact identity."}</p> : null}
        {capabilities.isFetching ? <span role="status">Checking runtime…</span> : null}
      </fieldset></EvaluationCard>
      <EvaluationCard title="Prompts"><fieldset disabled={locked}>
        {form.prompts.map((prompt, index) => <fieldset key={prompt.id}>
          <label>Prompt {index + 1}<textarea rows={3} value={prompt.text} maxLength={16_000}
            onChange={event => patch({ prompts: form.prompts.map(row => row.id === prompt.id ? { ...row, text: event.target.value } : row) })} /></label>
          <button type="button" className="training-text-button" onClick={() => patch({ prompts: form.prompts.filter(row => row.id !== prompt.id) })}>Remove prompt {index + 1}</button>
        </fieldset>)}
        <button type="button" className="training-button secondary" disabled={form.prompts.length >= 8}
          onClick={() => patch({ prompts: [...form.prompts, { id: crypto.randomUUID(), text: "" }] })}>Add prompt</button>
      </fieldset></EvaluationCard>
      <EvaluationCard title={method === "neuron_steering" ? "Steering coordinates" : "Capture coordinates"}><fieldset disabled={locked}>
        <p>Layer and neuron indices start at zero.{method === "neuron_steering" ? " Strength adds to the activation entering down_proj; weights stay unchanged." : " Inspection records selected activations without changing weights."}</p>
        {form.coordinates.map((coordinate, index) => <fieldset key={coordinate.id}>
          <legend>Coordinate {index + 1}</legend>
          <div className="activation-coordinate-fields">
            {coordinateFields.map(field => <label key={field}>
              {field === "dose" ? "Strength" : field === "layer" ? "Layer" : "Neuron"}
              <input aria-label={`${field === "dose" ? "Strength" : field === "layer" ? "Layer" : "Neuron"} ${index + 1}`} inputMode={field === "dose" ? "decimal" : "numeric"} value={coordinate[field]} maxLength={100}
                onChange={event => patch({ coordinates: form.coordinates.map(row => row.id === coordinate.id ? { ...row, [field]: event.target.value } : row) })} />
            </label>)}
          </div>
          <button type="button" className="training-text-button" onClick={() => patch({ coordinates: form.coordinates.filter(row => row.id !== coordinate.id) })}>Remove coordinate {index + 1}</button>
        </fieldset>)}
        <button type="button" className="training-button secondary" disabled={form.coordinates.length >= 64}
          onClick={() => patch({ coordinates: [...form.coordinates, { id: crypto.randomUUID(), layer: "", neuron: "", dose: "1" }] })}>Add coordinate</button>
        {method === "neuron_steering" ? <label>Dose multipliers<input value={form.doseMultipliers} maxLength={1000} onChange={event => patch({ doseMultipliers: event.target.value })} /><small>Comma-separated multipliers for the configured strengths. The comparison includes an unsteered baseline.</small></label> : null}
      </fieldset></EvaluationCard>
      <EvaluationCard title="Advanced"><details><summary>Capture and generation settings</summary><fieldset disabled={locked}>
        {method === "neuron_steering" ? <>
          <label>Apply during<DropdownSelect label="Apply during" floating value={form.tokenScope.phase}
            options={[{ value: "prompt_and_decode", label: "Prompt and generation" }, { value: "prompt_only", label: "Prompt only" }, { value: "decode_only", label: "Generation only" }]}
            onChange={value => patch({ tokenScope: { ...form.tokenScope, phase: value as ActivationExperimentFormDraft["tokenScope"]["phase"] } })} /></label>
          <label>Token positions<DropdownSelect label="Token positions" floating value={form.tokenScope.positions}
            options={[{ value: "all_non_padding", label: "All non-padding tokens" }, { value: "after_position_zero", label: "After the first token" }]}
            onChange={value => patch({ tokenScope: { ...form.tokenScope, positions: value as ActivationExperimentFormDraft["tokenScope"]["positions"] } })} /></label>
          <p>{form.normalization.mode === "baseline_prompt_residual_median" ? "Normalization uses a separate unsteered prompt pass and its frozen FP32 midpoint residual median." : `Fixed calibration retained: ${form.normalization.calibration.id} · r${form.normalization.calibration.revision}`}</p>
        </> : null}
        {([['maxNewTokens', 'Maximum generated tokens'], ['maximumCapturedValues', 'Maximum captured values'], ['maximumForwardTokenWork', 'Maximum forward-token work'], ['maximumDurationSeconds', 'Maximum seconds']] as const).map(([key, label]) => <label key={key}>{label}<input inputMode="numeric" value={form[key]} maxLength={100} onChange={event => patch({ [key]: event.target.value })} /></label>)}
      </fieldset></details></EvaluationCard>
      <label>Name<input value={name} maxLength={500} disabled={locked} onChange={event => setName(event.target.value)} /></label>
      <label>Spending limit (USD, optional)<input inputMode="decimal" placeholder="Use available credits" value={form.maximumSpendUsd??""} maxLength={100} disabled={locked} onChange={event=>patch({maximumSpendUsd:event.target.value})} /></label>
      <ErrorToast error={error ?? inputs.error ?? capabilities.error} />
      {inputs.error ? <button type="button" className="training-text-button" onClick={() => void inputs.refetch()}>Retry model list</button> : null}
      {capabilities.canRefresh ? <button type="button" className="training-text-button" disabled={capabilities.isFetching}
        onClick={() => void capabilities.refetch()}>Refresh runtime availability</button> : null}
      <button type="submit" className="training-button secondary" disabled={locked || !onSaveDraft}>{busy ? "Saving…" : "Save draft"}</button>
      <button type="button" className="training-button" disabled={locked || !onSaveDraft || !owner.ready || execution?.state!=="ready" || setup.startingModel?.source==="trained"} onClick={()=>void run()}>Run</button>
    </form>
    <ManagedActivationExecution api={api} owner={owner} />{guard.dialog}
  </WorkspacePanel>;
}
