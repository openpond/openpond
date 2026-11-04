import { useState } from "react";
import type { TrainingResult, TrainingResultSaveReceipt } from "openpond-sdk/training";
import { ErrorToast } from "../common/ErrorToast";
import { AppDialog } from "../dialogs/AppDialog";
import { useDraftNavigation } from "./useDraftNavigation";
import { useSaveTrainingModel } from "./useSaveTrainingModel";
import type { WorkspaceApi } from "./workspace/workspace-api";

export function SaveTrainingModelDialog({ api, result, onClose, onSaved }: {
  api: WorkspaceApi; result: TrainingResult; onClose(): void; onSaved(receipt: TrainingResultSaveReceipt, acknowledgementError: unknown): void;
}) {
  const [name, setName] = useState(result.model?.name ?? result.name);
  const save = useSaveTrainingModel(api, result);
  const retained = save.retained?.command.request;
  const guard = useDraftNavigation({ name: "Model save", busy: save.busy,
    dirty: !save.receipt && (Boolean(retained) || name !== (result.model?.name ?? result.name)),
    discardDescription: retained ? "The original save request stays in recovery. Reopening this result lets you retry that same request." : undefined,
  });
  return <>
    <AppDialog ariaLabel="Save model" className="labs-rename-dialog" backdropClassName="labs-rename-backdrop"
      dismissDisabled={save.busy} onClose={() => void guard.requestLeave(onClose)}>
      <h2>Save model</h2>
      <p>Save this checkpoint as a version of {result.model?.name ?? result.name}.</p>
      <ErrorToast error={save.error} />
      <form onSubmit={event => { event.preventDefault(); void save.save(name).then(saved => { if (saved) { guard.allowNextNavigation(); onSaved(saved.receipt, saved.acknowledgementError); } }); }}>
        <label className="model-build-field"><span>Model name</span><input data-autofocus maxLength={200} value={retained?.name ?? name}
          disabled={save.busy || !save.recoveryReady || Boolean(retained)} onChange={event => setName(event.target.value)} /></label>
        {retained ? <p>Original save request retained.</p> : null}
        <div className="model-build-actions">
          <button type="button" className="training-button secondary" disabled={save.busy} onClick={() => void guard.requestLeave(onClose)}>Cancel</button>
          {!save.recoveryReady ? <button type="button" className="training-button secondary" onClick={() => void save.refreshRecovery()}>Reload retained saves</button> : null}
          <button className="training-button" type="submit" disabled={save.busy || !save.recoveryReady}>{save.busy ? "Saving…" : retained ? "Retry original save" : "Save model"}</button>
        </div>
      </form>
    </AppDialog>
    {guard.dialog}
  </>;
}
