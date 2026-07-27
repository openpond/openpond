import type {
  BaseModelCandidate,
  TrainingCatalog,
  TrainingDestinationId,
} from "@openpond/contracts";
import type { ReactNode } from "react";

import {
  formatBytes,
  preparationStateLabel,
  type PortableTrainingMethod,
} from "./training-start-view-helpers";

type CatalogTarget = TrainingCatalog["targets"][number];
type CatalogModel = TrainingCatalog["models"][number];
type CatalogCompatibility = CatalogModel["compatibilities"][number];

export function TrainingCatalogSetup({
  busy,
  catalog,
  catalogError,
  catalogTargets,
  selectedComputeTarget,
  computeTargetId,
  onComputeTargetChange,
  modelSearch,
  onModelSearchChange,
  baseModelKey,
  baseModelCandidates,
  destinationId,
  method,
  onBaseModelChange,
  visibleCatalogModels,
  deviceId,
  selectableDevices,
  onDeviceChange,
  selectedCatalogCompatibility,
  selectedCatalogModel,
  configurationContent,
  inlineProviderApproval,
}: {
  busy: boolean;
  catalog: TrainingCatalog | null;
  catalogError: string | null;
  catalogTargets: CatalogTarget[];
  selectedComputeTarget: CatalogTarget | null;
  computeTargetId: string;
  onComputeTargetChange: (targetId: string) => void;
  modelSearch: string;
  onModelSearchChange: (query: string) => void;
  baseModelKey: string;
  baseModelCandidates: BaseModelCandidate[];
  destinationId: TrainingDestinationId;
  method: PortableTrainingMethod;
  onBaseModelChange: (selectionKey: string, modelId: string) => void;
  visibleCatalogModels: CatalogModel[];
  deviceId: string;
  selectableDevices: Array<{ id: string; name: string }>;
  onDeviceChange: (deviceId: string) => void;
  selectedCatalogCompatibility: CatalogCompatibility | null;
  selectedCatalogModel: CatalogModel | null;
  configurationContent?: ReactNode;
  inlineProviderApproval?: ReactNode;
}) {
  return (
    <>
      <div className="training-start-fields">
        <section
          className="training-catalog-setup"
          aria-label="Training compute and Model catalog"
        >
          <label className="training-catalog-field">
            <span>Compute</span>
            <select
              aria-label="Training compute"
              value={computeTargetId}
              disabled={busy || !catalog}
              onChange={(event) => onComputeTargetChange(event.target.value)}
            >
              <option value="" disabled>
                {catalog
                  ? "Choose training compute"
                  : "Loading compute catalog…"}
              </option>
              {catalogTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                  {target.available
                    ? ""
                    : ` — ${target.unavailableReason ?? "Setup required"}`}
                </option>
              ))}
            </select>
            <small>
              {selectedComputeTarget?.description ??
                "The server resolves devices, workers, runtimes, and engines."}
            </small>
          </label>
          <div
            className="training-capability-pills"
            aria-label="Training target capabilities"
          >
            {catalogTargets
              .filter((target) => target.id !== "automatic")
              .map((target) => (
                <span
                  className={target.available ? "available" : "unavailable"}
                  key={target.id}
                  title={target.unavailableReason ?? target.description}
                >
                  {target.capabilityPills[0]}
                </span>
              ))}
          </div>
          {catalogError ? (
            <p className="training-catalog-error">{catalogError}</p>
          ) : null}
          <label className="training-catalog-field">
            <span>Base model</span>
            <input
              aria-label="Search Model catalog"
              placeholder="Search all known Models"
              type="search"
              value={modelSearch}
              disabled={busy || !catalog}
              onChange={(event) => onModelSearchChange(event.target.value)}
            />
          </label>
          {!catalog ? (
            <label className="training-catalog-field">
              <select
                aria-label="Available base Models"
                value={baseModelKey}
                disabled={busy}
                onChange={(event) => {
                  const key = event.target.value;
                  const modelId =
                    baseModelCandidates.find(
                      (candidate) => candidate.selectionKey === key,
                    )?.preference.modelId ?? "";
                  onBaseModelChange(key, modelId);
                }}
              >
                <option value="" disabled>
                  Choose starting weights
                </option>
                {baseModelCandidates.map((candidate) => {
                  const option = candidate.executionOptions.find(
                    (item) =>
                      item.destinationId === destinationId &&
                      item.methods.includes(method),
                  );
                  return (
                    <option
                      disabled={!option?.available}
                      key={candidate.selectionKey}
                      value={candidate.selectionKey}
                    >
                      {candidate.label} · {candidate.sourceLabel}
                      {option?.available
                        ? ""
                        : ` — ${option?.unavailableReason ?? "Unsupported"}`}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : (
            <div
              className="training-model-catalog"
              role="listbox"
              aria-label="Available base Models"
            >
              {visibleCatalogModels.map((model) => {
                const compatibility = model.compatibilities.find(
                  (candidate) =>
                    candidate.targetId === selectedComputeTarget?.id &&
                    candidate.methods.includes(method),
                );
                const state = compatibility?.state ?? "unsupported";
                const reason =
                  compatibility?.reason ??
                  `This target does not support ${method.toUpperCase()} for this Model.`;
                const selectable = state !== "unsupported";
                return (
                  <button
                    aria-selected={model.selectionKey === baseModelKey}
                    className={`${model.selectionKey === baseModelKey ? "selected " : ""}${selectable ? "" : "unsupported"}`}
                    disabled={busy || !selectable}
                    key={model.selectionKey}
                    role="option"
                    title={reason}
                    type="button"
                    onClick={() =>
                      onBaseModelChange(model.selectionKey, model.modelId)
                    }
                  >
                    <span>
                      <strong>{model.label}</strong>
                      <small>
                        {model.modelId} · {model.source}
                      </small>
                    </span>
                    <span
                      className={`training-preparation-state ${state}`}
                    >
                      {preparationStateLabel(state)}
                    </span>
                    {reason ? <small>{reason}</small> : null}
                  </button>
                );
              })}
              {visibleCatalogModels.length === 0 ? (
                <p>
                  No Models match this search. Clear the search to see the full
                  catalog.
                </p>
              ) : null}
            </div>
          )}
          <div className="training-start-fields training-resolved-device">
            <label>
              <span>Device</span>
              <select
                value={deviceId}
                disabled={busy || destinationId !== "local_cpu_fixture"}
                onChange={(event) => onDeviceChange(event.target.value)}
              >
                <option value="automatic">Automatic</option>
                {selectableDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Training engine</span>
              <input
                readOnly
                value={
                  selectedComputeTarget?.engineAdapterId ?? "Resolving…"
                }
              />
            </label>
          </div>
          <p className="training-start-note">
            Inference runtime remains independent; this selection controls only
            student training compute.
          </p>
        </section>
      </div>
      {configurationContent}
      {inlineProviderApproval}
      <section
        className="training-preparation-summary"
        aria-label="Preparation summary"
      >
        <div>
          <strong>Preparation</strong>
          <span>
            {preparationStateLabel(
              selectedCatalogCompatibility?.state ??
                selectedCatalogModel?.preparationState ??
                "unsupported",
            )}
          </span>
        </div>
        <dl className="training-start-summary">
          <div>
            <dt>Model weights / cache</dt>
            <dd>
              {selectedCatalogModel?.cached
                ? "Pinned revision is cached"
                : selectedCatalogModel?.expectedBytes != null
                  ? `${formatBytes(selectedCatalogModel.expectedBytes)} download after Run review`
                  : "Resolved during Run review"}
            </dd>
          </div>
          <div>
            <dt>Worker image</dt>
            <dd>
              {selectedComputeTarget?.engineAdapterId === "local-trl"
                ? "Bundled CPU reference worker"
                : "Backend-pinned immutable image"}
            </dd>
          </div>
          <div>
            <dt>Harness runtime</dt>
            <dd>
              {selectedComputeTarget?.runtimeAdapterId ?? "Resolving…"}
            </dd>
          </div>
          <div>
            <dt>Data movement</dt>
            <dd>
              {selectedComputeTarget?.computeAdapterId === "local-cpu"
                ? "No remote transfer"
                : "Exact upload and artifact return shown before approval"}
            </dd>
          </div>
        </dl>
        <p>
          Selection starts no download, connection, upload, provisioning, or
          spend. The top-level Run review shows exact actions and approvals.
        </p>
      </section>
    </>
  );
}
