import { useState } from "react";
import { MODEL_SERVING_IDLE_TIMEOUT_SECONDS, type SavedModelServing, type SavedModelVersion } from "openpond-sdk/training";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { AppDialog } from "../dialogs/AppDialog";
import { useDraftNavigation } from "./useDraftNavigation";
import { useModelServingControl } from "./useModelServingControl";
import type { WorkspaceApi } from "./workspace/workspace-api";

export function ModelServingControlDialog({
  api,
  value,
  version,
  action,
  onClose,
}: {
  api: WorkspaceApi;
  value?: SavedModelServing;
  version: SavedModelVersion;
  action: "activate" | "stop";
  onClose(): void;
}) {
  const saved = useModelServingControl(api, version.modelProjectId, value);
  const idle = MODEL_SERVING_IDLE_TIMEOUT_SECONDS;
  const [defaultProfile, setDefaultProfile] = useState(
    value?.schemaVersion === "openpond.engramModelServing.v1"
      ? value.defaultEnabled
      : value?.schemaVersion === "openpond.steeringModelServing.v1"
        ? value.defaultPublication !== null
        : true,
  );
  const retained = saved.retained?.command.request,
    actual = retained?.action ?? action;
  const allowed =
    value &&
    (actual === "activate"
      ? (value.schemaVersion === "openpond.steeringModelServing.v1" ||
        value.schemaVersion === "openpond.engramModelServing.v1" ||
        value.schemaVersion === "openpond.decisionModelServing.v1" ||
        value.schemaVersion === "openpond.alphaEditModelServing.v1" ||
        value.schemaVersion === "openpond.neuronTrainingModelServing.v1"
          ? value.availability.state === "qualified" &&
            !value.cleanup.some((row) => !["shared", "released"].includes(row.capacityState))
          : value.registry?.qualified) && value.control?.phase !== "stopping"
      : value.control?.desiredState === "active" &&
        value.control.versionHash === version.contentHash);
  const guard = useDraftNavigation({
    name: "Serving setup",
    busy: saved.busy,
    dirty:
      Boolean(retained) ||
      (version.schemaVersion === "openpond.engramModelVersion.v1" &&
        defaultProfile !==
          (value?.schemaVersion === "openpond.engramModelServing.v1"
            ? value.defaultEnabled
            : true)) ||
      (version.schemaVersion === "openpond.steeringModelVersion.v1" &&
        defaultProfile !==
          (value?.schemaVersion === "openpond.steeringModelServing.v1"
            ? value.defaultPublication !== null
            : true)),
    discardDescription: retained
      ? "The original serving command stays in recovery so you can retry it after reopening this Model."
      : undefined,
  });
  return (
    <>
      <AppDialog
        ariaLabel={actual === "activate" ? "Activate Model" : "Stop Model"}
        className="labs-rename-dialog"
        backdropClassName="labs-rename-backdrop"
        dismissDisabled={saved.busy}
        onClose={() => void guard.requestLeave(onClose)}
      >
        <h2>{actual === "activate" ? "Activate Model" : "Stop Model"}</h2>
        <ErrorToast error={saved.error} />
        <p>
          {actual === "activate"
            ? "Activate this exact saved version using workspace capacity and credits. This may allocate paid serving capacity."
            : "Stop new requests to this Model. Outstanding requests finish before unused capacity can retire; shared capacity may remain in use."}
        </p>
        <p>
          {version.schemaVersion === "openpond.steeringModelVersion.v1"
            ? version.publication.baseModel.modelId
            : version.schemaVersion === "openpond.engramModelVersion.v1" ||
                version.schemaVersion === "openpond.decisionModelVersion.v1" ||
                version.schemaVersion === "openpond.alphaEditModelVersion.v1" ||
                version.schemaVersion === "openpond.neuronTrainingModelVersion.v1"
              ? version.baseModel.modelId
              : version.request.baseModel.modelId}
        </p>
        <p className="saved-model-version-reference">
          Saved version {retained?.versionHash ?? version.contentHash}
        </p>
        {actual === "activate" &&
        (retained
          ? retained.schemaVersion === "openpond.steeringModelServingControlRequest.v1" ||
            retained.schemaVersion === "openpond.engramModelServingControlRequest.v1"
          : version.schemaVersion === "openpond.steeringModelVersion.v1" ||
            version.schemaVersion === "openpond.engramModelVersion.v1") ? (
          <label className="model-build-field">
            <span>Default modification</span>
            <DropdownSelect
              label="Default modification"
              value={
                retained?.schemaVersion === "openpond.engramModelServingControlRequest.v1"
                  ? retained.defaultEnabled
                    ? "profile"
                    : "off"
                  : retained?.schemaVersion === "openpond.steeringModelServingControlRequest.v1"
                    ? retained.defaultPublication
                      ? "profile"
                      : "off"
                    : defaultProfile
                      ? "profile"
                      : "off"
              }
              options={[
                {
                  value: "profile",
                  label:
                    version.schemaVersion === "openpond.engramModelVersion.v1"
                      ? "Saved memory module"
                      : "Saved profile",
                },
                { value: "off", label: "Off" },
              ]}
              disabled={saved.busy || Boolean(retained)}
              onChange={(next) => setDefaultProfile(next === "profile")}
            />
          </label>
        ) : null}
        {actual === "activate" ? (
          <p>Idle timeout: {(retained?.idleTimeoutSeconds ?? idle) / 60} minutes.</p>
        ) : null}
        {retained ? <p>Original {retained.action} request retained.</p> : null}
        {saved.receipt ? (
          <p role="status">
            Request accepted. Retaining recovery until its acknowledgment completes.
          </p>
        ) : null}
        <div className="model-build-actions">
          <button
            type="button"
            className="training-button secondary"
            disabled={saved.busy}
            onClick={() => void guard.requestLeave(onClose)}
          >
            Close
          </button>
          {!saved.recoveryReady ? (
            <button
              type="button"
              className="training-button secondary"
              onClick={() => void saved.refreshRecovery()}
            >
              Reload retained commands
            </button>
          ) : null}
          <button
            type="button"
            className="training-button"
            disabled={saved.busy || !saved.recoveryReady || (!retained && !allowed)}
            onClick={() =>
              void saved
                .run(
                  actual,
                  retained?.idleTimeoutSeconds ??
                    (actual === "stop" ? (value?.control?.idleTimeoutSeconds ?? idle) : idle),
                  version.schemaVersion === "openpond.steeringModelVersion.v1" && defaultProfile
                    ? {
                        id: version.publication.id,
                        revision: version.publication.revision,
                        contentHash: version.publication.contentHash,
                      }
                    : null,
                  defaultProfile,
                )
                .then((receipt) => {
                  if (receipt) {
                    guard.allowNextNavigation();
                    onClose();
                  }
                })
            }
          >
            {saved.busy
              ? "Applying…"
              : retained
                ? `Retry original ${retained.action}`
                : actual === "activate"
                  ? "Activate"
                  : "Stop serving"}
          </button>
        </div>
      </AppDialog>
      {guard.dialog}
    </>
  );
}
