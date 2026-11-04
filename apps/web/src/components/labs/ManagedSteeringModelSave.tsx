import { useState } from "react";
import type { ManagedModificationExecution } from "openpond-sdk/training";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { AppDialog } from "../dialogs/AppDialog";
import { useDraftNavigation } from "./useDraftNavigation";
import { useSaveSteeringModel } from "./useSaveSteeringModel";
import { SavedModelServing } from "./SavedModelServing";
import type { WorkspaceApi } from "./workspace/workspace-api";

export function ManagedSteeringModelSave({
  api,
  id,
  execution,
  disabled = false,
}: {
  api: WorkspaceApi;
  id: string;
  execution?: ManagedModificationExecution;
  disabled?: boolean;
}) {
  const owner = useSaveSteeringModel(api, id, execution);
  const [open, setOpen] = useState(false),
    [name, setName] = useState((execution?.name ?? "Steering Model").slice(0, 200));
  const [variantId, setVariantId] = useState(""),
    [target, setTarget] = useState("");
  const variants = execution?.request.variants.filter((row) => row.profile !== null) ?? [];
  const selected = variants.some((row) => row.id === variantId)
    ? variantId
    : (variants[0]?.id ?? "");
  const retained = owner.original?.command;
  const guard = useDraftNavigation({
    name: "Steering Model save",
    busy: owner.busy,
    dirty:
      open &&
      (Boolean(retained) ||
        name !== (execution?.name ?? "Steering Model").slice(0, 200) ||
        Boolean(target) ||
        Boolean(variantId)),
    discardDescription: retained
      ? "The original save remains recoverable from this execution after closing."
      : undefined,
  });
  if (execution?.method === "inspect_activations") return null;
  const canSave =
    execution?.method === "neuron_steering" &&
    execution.phase === "completed" &&
    execution.result !== null &&
    variants.length > 0;
  const recoveryFailed = !owner.recoveryReady && owner.error !== null;
  if (!canSave && !retained && !owner.receipt && !recoveryFailed) return null;
  const version = owner.receipt?.version;
  return (
    <section className="training-detail-section" aria-label="Save steering Model">
      <ErrorToast error={owner.error} />
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
          <SavedModelServing
            key={`${api.key}:${version.contentHash}`}
            connection={api.connection}
            version={version}
            api={api}
          />
        </>
      ) : null}
      <button
        type="button"
        className="training-button"
        disabled={disabled || owner.busy || !owner.recoveryReady}
        onClick={() => setOpen(true)}
      >
        {retained ? "Recover Model save" : owner.receipt ? "Save another variant" : "Save model"}
      </button>
      {open ? (
        <AppDialog
          ariaLabel="Save steering model"
          className="labs-rename-dialog"
          backdropClassName="labs-rename-backdrop"
          dismissDisabled={owner.busy}
          onClose={() => void guard.requestLeave(() => setOpen(false))}
        >
          <h2>Save model</h2>
          <p>
            Save one exact profile from the completed hosted result. Off remains the control
            comparison; saving does not activate serving.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void owner
                .save({ name, variantId: selected, modelProjectId: target || null })
                .then((receipt) => {
                  if (receipt) {
                    guard.allowNextNavigation();
                    setOpen(false);
                  }
                });
            }}
          >
            <label className="model-build-field">
              <span>Profile variant</span>
              <DropdownSelect
                label="Profile variant"
                value={retained?.variantId ?? selected}
                options={
                  retained
                    ? [{ value: retained.variantId, label: retained.variantId }]
                    : variants.map((row) => ({ value: row.id, label: row.id }))
                }
                disabled={owner.busy || Boolean(retained)}
                onChange={setVariantId}
              />
            </label>
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
                Original result, profile, destination and revision are retained. Retry sends the
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
