import { useEffect, useRef, useState } from "react";
import { decisionFormFromModelVersion, experimentStartingModelFromDecisionVersion, ExperimentDraftSchema, type ManagedDecisionExecution } from "openpond-sdk/training";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { AppDialog } from "../dialogs/AppDialog";
import { useDraftNavigation } from "./useDraftNavigation";
import { useSaveDecisionModel } from "./useSaveDecisionModel";
import { useEvaluationSetup } from "./workspace/EvaluationSetupState";
import { initialDecisionForm } from "./workspace/decision-form-defaults";
import { SavedModelServing } from "./SavedModelServing";
import { modelsLocation, navigateModelsRoute } from "./lab-primary-tab-state";
import type { WorkspaceApi } from "./workspace/workspace-api";

export function ManagedDecisionModelSave({
  api,
  id,
  execution,
  disabled = false,
}: {
  api: WorkspaceApi;
  id: string;
  execution?: ManagedDecisionExecution;
  disabled?: boolean;
}) {
  const owner = useSaveDecisionModel(api, id, execution), setup = useEvaluationSetup();
  const [sourceError, setSourceError] = useState<unknown>(null);
  const scope = `${api.key}:${id}`, live = useRef(scope); live.current = scope;
  useEffect(() => {live.current = scope; return () => {live.current = "";};}, [scope]);
  async function newExperiment() {
    const saved = owner.receipt;
    if (!saved || owner.busy || owner.original || disabled) return;
    try {
      const draft = ExperimentDraftSchema.parse({schemaVersion: "openpond.experimentDraft.v1", id: crypto.randomUUID(), operationType: "decision_model", name: `${saved.model.name} Decision experiment`,
        startingModel: await experimentStartingModelFromDecisionVersion(saved.version, {teamId: api.teamId, label: `${saved.model.name} / Saved decision adapter`}),
        decisionForm: await decisionFormFromModelVersion(initialDecisionForm(), saved.version, {teamId: api.teamId}),
      });
      if (live.current === scope) await setup.openDraft(draft, modelsLocation("experiments", null, {projectId: api.projectId, executionLocation: "hosted"}));
    } catch (cause) {if (live.current === scope) setSourceError(cause);}
  }
  const [open, setOpen] = useState(false),
    [name, setName] = useState((execution?.name ?? "Decision Model").slice(0, 200));
  const [target, setTarget] = useState("");
  const retained = owner.original?.command;
  const guard = useDraftNavigation({
    name: "Decision Model save",
    busy: owner.busy,
    dirty:
      open &&
      (Boolean(retained) ||
        name !== (execution?.name ?? "Decision Model").slice(0, 200) ||
        Boolean(target)),
    discardDescription: retained
      ? "The original save remains recoverable from this execution after closing."
      : undefined,
  });
  const canSave =
    execution?.method === "decision_model" &&
    execution.phase === "completed" &&
    execution.result?.schemaVersion === "openpond.decisionTrainingResult.v1";
  const recoveryFailed = !owner.recoveryReady && owner.error !== null;
  if (!canSave && !retained && !owner.receipt && !recoveryFailed) return null;
  const version = owner.receipt?.version;
  return (
    <section className="training-detail-section" aria-label="Save Decision Model">
      <ErrorToast error={sourceError ?? owner.error} />
      {!owner.recoveryReady ? (
        <button
          type="button"
          className="training-button secondary"
          disabled={owner.busy}
          onClick={owner.refresh}
        >
          Reload retained Model saves
        </button>
      ) : null}
      {owner.receipt && version ? (
        <>
          <p>
            Saved to {owner.receipt.model?.name}. Exact version <code>{version.contentHash}</code>.
          </p>
          <details><summary>Exact saved version</summary><pre className="saved-model-version-reference">{JSON.stringify(version, null, 2)}</pre></details>
          <div className="model-build-actions"><button type="button" className="training-button secondary" onClick={() => void navigateModelsRoute(modelsLocation("models"))}>Open Models</button><button type="button" className="training-button" disabled={disabled || owner.busy || Boolean(retained)} onClick={() => void newExperiment()}>New experiment from saved module</button></div>
          <SavedModelServing key={`${api.key}:${version.contentHash}`} connection={api.connection} version={version} api={api} />
        </>
      ) : null}
      <button
        type="button"
        className="training-button"
        disabled={disabled || owner.busy || !owner.recoveryReady}
        onClick={() => setOpen(true)}
      >
        {retained ? "Recover Model save" : owner.receipt ? "Save model again" : "Save model"}
      </button>
      {open ? (
        <AppDialog
          ariaLabel="Save Decision model"
          className="labs-rename-dialog"
          backdropClassName="labs-rename-backdrop"
          dismissDisabled={owner.busy}
          onClose={() => void guard.requestLeave(() => setOpen(false))}
        >
          <h2>Save model</h2>
          <p>
            Save the exact trained decision adapter from this completed result. Saving does not activate serving.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void owner
                .save({ name, modelProjectId: target || null })
                .then((receipt) => {
                  if (receipt) {
                    guard.allowNextNavigation();
                    setOpen(false);
                  }
                });
            }}
          >
            <label className="model-build-field">
              <span>Save destination</span>
              <DropdownSelect
                label="Model destination"
                value={retained?.modelProjectId ?? (retained ? "" : target)}
                options={[
                  { value: "", label: "Create new Model" },
                  ...(owner.options?.models ?? []).map((model) => ({
                    value: model.id,
                    label: model.name,
                    description: `Current revision ${model.revision}`,
                  })),
                  ...(retained?.modelProjectId &&
                  !owner.options?.models.some((model) => model.id === retained.modelProjectId)
                    ? [{ value: retained.modelProjectId, label: "Original selected Model" }]
                    : []),
                ]}
                disabled={owner.busy || Boolean(retained) || !owner.freshReady}
                onChange={(value) => {
                  setTarget(value);
                  const model = owner.options?.models.find((row) => row.id === value);
                  if (model) setName(model.name);
                }}
              />
            </label>
            <label className="model-build-field">
              <span>Model name</span>
              <input
                data-autofocus
                value={retained?.name ?? name}
                maxLength={200}
                disabled={owner.busy || Boolean(retained)}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {retained ? (
              <p>
                Original result, module, destination and revision are retained. Retry sends the
                same operation.
              </p>
            ) : null}
            {owner.receipt && retained ? (
              <p role="status">
                The Model was saved. Local acknowledgement is pending; retry preserves its exact
                receipt.
              </p>
            ) : null}
            <div className="model-build-actions">
              <button
                type="button"
                className="training-button secondary"
                disabled={owner.busy}
                onClick={() => void guard.requestLeave(() => setOpen(false))}
              >
                Close
              </button>
              <button
                type="button"
                className="training-button secondary"
                disabled={owner.busy}
                onClick={owner.refresh}
              >
                Refresh targets and recovery
              </button>
              <button
                type="submit"
                className="training-button"
                disabled={
                  owner.busy || disabled || !owner.recoveryReady || (!retained && !owner.freshReady)
                }
              >
                {owner.busy ? "Saving…" : retained ? "Retry original save" : "Save model"}
              </button>
            </div>
          </form>
        </AppDialog>
      ) : null}
      {guard.dialog}
    </section>
  );
}
