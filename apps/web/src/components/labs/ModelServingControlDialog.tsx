import { useState } from "react";
import {
  MODEL_SERVING_IDLE_TIMEOUT_SECONDS,
  SERVERLESS_SERVING_IDLE_SECONDS,
  type SavedModelServing,
  type SavedModelVersion,
} from "openpond-sdk/training";
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
  const retained = saved.retained?.command.request;
  const serverless =
    version.schemaVersion === "openpond.trainingModelVersion.v1" &&
    (!retained || ("serverlessApproval" in retained && Boolean(retained.serverlessApproval)));
  const idle = serverless ? SERVERLESS_SERVING_IDLE_SECONDS : MODEL_SERVING_IDLE_TIMEOUT_SECONDS;
  const [spendingLimit, setSpendingLimit] = useState("");
  const [gpuTypeId, setGpuTypeId] = useState("");
  const availableReview =
    value?.schemaVersion === "openpond.trainingModelServing.v1" ? value.serverlessReview : null;
  const [defaultProfile, setDefaultProfile] = useState(
    value?.schemaVersion === "openpond.engramModelServing.v1"
      ? value.defaultEnabled
      : value?.schemaVersion === "openpond.steeringModelServing.v1"
        ? value.defaultPublication !== null
        : true,
  );
  const actual = retained?.action ?? action;
  const acceptedReview =
    value?.schemaVersion === "openpond.trainingModelServing.v1"
      ? value.control?.serverless?.review
      : null;
  const retainedReviewHash =
    retained && "serverlessApproval" in retained ? retained.serverlessApproval?.reviewHash : null;
  const serverlessReview = retainedReviewHash
    ? [acceptedReview, availableReview].find((review) => review?.contentHash === retainedReviewHash)
    : availableReview;
  const allowed =
    value &&
    (actual === "activate"
      ? (value.schemaVersion === "openpond.steeringModelServing.v1" ||
        value.schemaVersion === "openpond.engramModelServing.v1" ||
        value.schemaVersion === "openpond.decisionModelServing.v1" ||
        value.schemaVersion === "openpond.alphaEditModelServing.v1" ||
        value.schemaVersion === "openpond.neuronTrainingModelServing.v1" ||
        value.schemaVersion === "openpond.weightSpaceModelServing.v1"
          ? value.availability.state === "qualified" &&
            !value.cleanup.some((row) => !["shared", "released"].includes(row.capacityState))
          : value.registry?.qualified && Boolean(serverlessReview)) &&
        value.control?.phase !== "stopping"
      : value.control?.desiredState === "active" &&
        value.control.versionHash === version.contentHash);
  const guard = useDraftNavigation({
    name: "Serving setup",
    busy: saved.busy,
    dirty:
      Boolean(retained) ||
      (serverless && (spendingLimit.length > 0 || gpuTypeId.length > 0)) ||
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
        ariaLabel={actual === "activate" ? "Serve model" : "Stop serving"}
        className="labs-rename-dialog"
        backdropClassName="labs-rename-backdrop"
        dismissDisabled={saved.busy}
        onClose={() => void guard.requestLeave(onClose)}
      >
        <h2>{actual === "activate" ? "Serve model" : "Stop serving"}</h2>
        <ErrorToast error={saved.error} />
        <p>
          {actual === "activate"
            ? serverless
              ? "Serve this model on demand using workspace credits."
              : "Serve this model using workspace capacity and credits."
            : "Stop new requests to this Model. Outstanding requests finish before unused capacity can retire; shared capacity may remain in use."}
        </p>
        <p>
          {version.schemaVersion === "openpond.steeringModelVersion.v1"
            ? version.publication.baseModel.modelId
            : version.schemaVersion === "openpond.engramModelVersion.v1" ||
                version.schemaVersion === "openpond.decisionModelVersion.v1" ||
                version.schemaVersion === "openpond.alphaEditModelVersion.v1" ||
                version.schemaVersion === "openpond.neuronTrainingModelVersion.v1" ||
                version.schemaVersion === "openpond.weightSpaceModelVersion.v1"
              ? version.baseModel.modelId
              : version.request.baseModel.modelId}
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
        {actual === "activate" && serverless ? (
          <>
            {serverlessReview?.schemaVersion === "openpond.serverlessServingReview.v3" && serverlessReview.hardware ? (
              <label className="model-build-field"><span>GPU</span><DropdownSelect label="GPU"
                value={(retained && "serverlessApproval" in retained ? retained.serverlessApproval?.gpuTypeId : gpuTypeId) || "automatic"}
                options={[{ value: "automatic", label: "Automatic" }, ...serverlessReview.hardware.gpuTypeIds.map(id => ({ value: id, label: id }))]}
                disabled={saved.busy || Boolean(retained)} onChange={id => setGpuTypeId(id === "automatic" ? "" : id)} /></label>
            ) : null}
            {serverlessReview ? (
              <p>
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 9,
                }).format(Number(serverlessReview.price.hourlyUsd) / 3_600)}{" "}
                per second (US${serverlessReview.price.hourlyUsd} per hour equivalent), billed for
                your allocated share of{" "}
                {serverlessReview.rules.startupBillable
                  ? "worker runtime, including startup, model loading, execution and idle time through full shutdown. Failed startup is billable. Waiting without a running worker is not billed."
                  : "engine execution. These retained terms exclude startup, queue and idle time."}
              </p>
            ) : null}
            <label className="model-build-field">
              <span>Serving spending limit (USD, optional)</span>
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={
                  retained && "serverlessApproval" in retained
                    ? (retained.serverlessApproval?.customerCapUsd ?? "")
                    : spendingLimit
                }
                disabled={saved.busy || Boolean(retained)}
                onChange={(event) => setSpendingLimit(event.currentTarget.value)}
              />
            </label>
            <p>
              {serverlessReview?.schemaVersion === "openpond.serverlessServingReview.v3"
                ? "Measured runtime is charged against workspace credits. Serving stops when your spending limit or available credits run out."
                : "Requests reserve bounded funding until their usage is reconciled. Unused GPUs are released automatically."}
            </p>
          </>
        ) : actual === "activate" ? (
          <p>Idle timeout: {(retained?.idleTimeoutSeconds ?? idle) / 60} minutes.</p>
        ) : null}
        {saved.receipt ? (
          <p role="status">
            Request accepted.
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
                  spendingLimit || null,
                  gpuTypeId || undefined,
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
                ? "Retry request"
                : actual === "activate"
                  ? "Serve"
                  : "Stop serving"}
          </button>
        </div>
      </AppDialog>
      {guard.dialog}
    </>
  );
}
