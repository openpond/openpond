import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ComputeStateResponse,
  DatasetCatalogItem,
  DatasetCatalogResponse,
} from "@openpond/contracts";
import { RefreshCw } from "../icons";
import { ModelStoragePicker } from "./ModelStoragePicker";

export function DatasetStorageSettingsSection({
  state,
  catalog,
  busy,
  catalogLoading,
  onRefresh,
  onSave,
}: {
  state: ComputeStateResponse | null;
  catalog: DatasetCatalogResponse | null;
  busy: "load" | "scan" | "save" | null;
  catalogLoading: boolean;
  onRefresh: () => Promise<void>;
  onSave: (datasetStorePath: string | null) => Promise<boolean>;
}) {
  const [datasetStorePath, setDatasetStorePath] = useState<string | null>(
    state?.settings.datasetStorePath ?? null,
  );
  useEffect(() => {
    setDatasetStorePath(state?.settings.datasetStorePath ?? null);
  }, [state?.settings.datasetStorePath]);

  const selectedStorage = useMemo(
    () => state?.inventory?.storageRoots.find(
      (root) =>
        normalizedPath(root.datasetStorePath)
        === normalizedPath(datasetStorePath),
    ) ?? null,
    [datasetStorePath, state?.inventory?.storageRoots],
  );
  const unchanged =
    datasetStorePath === (state?.settings.datasetStorePath ?? null);
  const datasets = catalog?.datasets ?? [];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave(datasetStorePath);
  }

  return (
    <section className="account-settings compute-settings dataset-storage-settings">
      <div className="compute-title-row">
        <div>
          <h1>Dataset Storage</h1>
          <p className="dataset-storage-intro">
            Choose where Dataset artifacts are saved and review registered
            Datasets without loading their rows.
          </p>
        </div>
        <button
          aria-label="Refresh Dataset storage"
          className="settings-icon-button"
          disabled={busy !== null || catalogLoading}
          onClick={() => void onRefresh()}
          title="Refresh Dataset storage"
          type="button"
        >
          <RefreshCw
            className={catalogLoading ? "settings-spin" : undefined}
            size={15}
          />
        </button>
      </div>

      <div className="account-summary">
        <div className="account-summary-main compute-summary-main">
          <div>
            <strong>
              {selectedStorage?.label
                ?? (datasetStorePath ? "Manual location" : "Not configured")}
            </strong>
            <small>
              {datasetStorePath
                ?? "Choose a writable local or mounted location before importing a Dataset."}
            </small>
            {selectedStorage ? (
              <small>
                {storageKindLabel(selectedStorage.kind)}
                {" · "}
                {selectedStorage.freeBytes == null
                  ? "Free space unknown"
                  : `${formatBytes(selectedStorage.freeBytes)} free`}
              </small>
            ) : null}
          </div>
        </div>
      </div>

      <form
        className="provider-settings-form"
        onSubmit={(event) => void save(event)}
      >
        <div className="account-list-heading"><span>Location</span></div>
        <ModelStoragePicker
          disabled={busy !== null}
          onChange={setDatasetStorePath}
          purpose="dataset"
          storageRoots={state?.inventory?.storageRoots ?? []}
          value={datasetStorePath}
        />
        <button
          className="settings-primary"
          disabled={busy !== null || unchanged}
        >
          {busy === "save" ? "Saving" : "Save Dataset storage"}
        </button>
      </form>

      <div className="account-list dataset-storage-list">
        <div className="account-list-heading">
          <span>Registered Datasets</span>
          <small>{datasets.length}</small>
        </div>
        {datasets.length ? datasets.map((dataset) => (
          <DatasetStorageRow dataset={dataset} key={dataset.tasksetId} />
        )) : (
          <div className="empty-account-list">
            <span>
              {catalogLoading
                ? "Loading registered Datasets"
                : "No registered Datasets"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function DatasetStorageRow({ dataset }: { dataset: DatasetCatalogItem }) {
  const storedAs = dataset.storageKind === "parquet"
    ? "Parquet"
    : "Inline Taskset";
  return (
    <div className="compute-row dataset-storage-row">
      <div>
        <strong>{dataset.name}</strong>
        <small>
          {formatNumber(dataset.rowCount)} rows
          {" · "}
          {splitSummary(dataset)}
          {" · "}
          {storedAs}
          {" · "}
          {dataset.sizeBytes == null ? "Size unavailable" : formatBytes(dataset.sizeBytes)}
        </small>
        {!dataset.available && dataset.unavailableReason ? (
          <small className="dataset-storage-error">
            {dataset.unavailableReason}
          </small>
        ) : null}
      </div>
      <span>
        {dataset.available ? statusLabel(dataset.status) : "Unavailable"}
      </span>
    </div>
  );
}

function splitSummary(dataset: DatasetCatalogItem): string {
  const summary = [
    ["train", dataset.splitCounts.train],
    ["validation", dataset.splitCounts.validation],
    ["test", dataset.splitCounts.test],
    ["frozen eval", dataset.splitCounts.frozen_eval],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${formatNumber(Number(count))} ${label}`)
    .join(" · ");
  return summary || "No split rows";
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1_024;
    unit += 1;
  } while (amount >= 1_024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function normalizedPath(value: string | null): string {
  return value?.replace(/[\\/]+$/, "") ?? "";
}

function statusLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function storageKindLabel(value: string): string {
  return value.replace(/^./, (letter) => letter.toUpperCase());
}
