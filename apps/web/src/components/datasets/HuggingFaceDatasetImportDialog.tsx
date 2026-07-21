import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DatasetFieldBinding,
  DatasetImportJob,
  DatasetImportMapping,
  DatasetMappingTarget,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { ArrowLeft, ExternalLink, Loader2, X } from "../icons";
import { AppDialog } from "../dialogs/AppDialog";

type TrainingController = ReturnType<typeof useTraining>;

const TARGETS: DatasetMappingTarget[] = [
  "row_id",
  "cluster_id",
  "prompt",
  "messages",
  "demonstration",
  "chosen",
  "rejected",
  "expected_output",
  "privileged_context",
  "reward",
  "feedback",
  "tag",
  "metadata",
];
const POLICIES: DatasetFieldBinding["policy"][] = [
  "visible",
  "privileged",
  "metadata",
];

export function HuggingFaceDatasetImportDialog({
  onBack,
  onClose,
  onImported,
  onOpenDatasetStorageSettings,
  training,
}: {
  onBack: () => void;
  onClose: () => void;
  onImported: (tasksetId: string) => void | Promise<void>;
  onOpenDatasetStorageSettings: () => void;
  training: TrainingController;
}) {
  const [locator, setLocator] = useState("");
  const [snapshot, setSnapshot] = useState<DatasetImportJob | null>(null);
  const [mapping, setMapping] = useState<DatasetImportMapping | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [licenseApproved, setLicenseApproved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const completedRef = useRef<string | null>(null);
  const persisted = training.payload?.datasetImports.find(
    (job) => job.id === snapshot?.id,
  );
  const job = persisted ?? snapshot;
  const inspection = job?.inspection ?? null;
  const active = Boolean(
    job && ["inspecting", "materializing", "validating", "cancelling"].includes(job.status),
  );
  const requiresLicenseApproval = !inspection?.declaredLicense
    || ["unknown", "other"].includes(inspection.declaredLicense.toLowerCase());
  const sourceBytes = useMemo(
    () => inspection?.sourceFiles.reduce<number | null>(
      (total, file) =>
        total === null || file.sizeBytes === null
          ? null
          : total + file.sizeBytes,
      0,
    ) ?? null,
    [inspection],
  );

  useEffect(() => {
    if (!job || job.status !== "ready" || !job.tasksetId) return;
    if (completedRef.current === job.id) return;
    completedRef.current = job.id;
    void onImported(job.tasksetId);
  }, [job, onImported]);

  async function inspect() {
    if (!locator.trim()) return;
    setLocalError(null);
    const next = await training.actions.inspectHuggingFaceDataset(locator);
    if (!next) {
      setLocalError(training.error ?? "OpenPond could not inspect this Dataset.");
      return;
    }
    setSnapshot(next);
    if (next.inspection && next.mapping) initializeReview(next);
  }

  function initializeReview(next: DatasetImportJob) {
    setMapping(next.mapping);
    setName(next.inspection?.title ?? next.locator?.repositoryId.split("/").at(-1) ?? "Imported Dataset");
    setObjective(
      next.inspection?.description?.trim().slice(0, 2_000)
      || `Train and evaluate tasks from ${next.locator?.repositoryId ?? "this Dataset"}.`,
    );
  }

  function updateBinding(
    index: number,
    patch: Partial<DatasetFieldBinding>,
  ) {
    setMapping((current) => current
      ? {
          ...current,
          bindings: current.bindings.map((binding, bindingIndex) =>
            bindingIndex === index ? { ...binding, ...patch } : binding),
        }
      : current);
  }

  async function materialize() {
    if (!job || !mapping || !name.trim() || !objective.trim()) return;
    setLocalError(null);
    const next = await training.actions.materializeDatasetImport(job.id, {
      name: name.trim(),
      objective: objective.trim(),
      mapping,
      targetStorageRoot: null,
      licenseApproved,
    });
    if (!next) {
      setLocalError(
        training.error
        ?? "OpenPond could not start Dataset materialization.",
      );
      return;
    }
    setSnapshot(next);
  }

  async function cancel() {
    if (!job) return;
    const next = await training.actions.cancelDatasetImport(job.id);
    if (next) setSnapshot(next);
  }

  const reviewing = Boolean(inspection && mapping)
    && !["materializing", "validating", "ready", "cancelling", "cancelled"].includes(job?.status ?? "");

  return (
    <AppDialog
      ariaLabel="Import Hugging Face Dataset"
      className="training-dialog training-run-dialog training-run-workflow-step dataset-import-dialog"
      dismissDisabled={active}
      initialFocusKey={inspection ? "review" : "locator"}
      onClose={onClose}
    >
        <div className="training-dialog-header">
          <div className="training-run-dialog-title">
            <button
              aria-label="Back to Dataset sources"
              className="training-icon-button"
              type="button"
              onClick={onBack}
            >
              <ArrowLeft size={16} />
            </button>
            <h2>Import from Hugging Face</h2>
          </div>
          <button
            aria-label="Close"
            className="training-icon-button"
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {!inspection ? (
          <div className="training-dialog-scroll-body dataset-import-locator">
            <div className="training-run-step-heading">
              <h3>Paste a Dataset URL</h3>
              <p>
                OpenPond inspects the public repository, pins its exact commit,
                and shows the fields before downloading any rows.
              </p>
            </div>
            <label className="training-objective-field">
              <span>Hugging Face URL or repository ID</span>
              <input
                data-autofocus
                disabled={active}
                placeholder="BytedTsinghua-SIA/DAPO-Math-17k"
                value={locator}
                onChange={(event) => setLocator(event.target.value)}
              />
            </label>
            {job?.status === "failed" && job.error ? (
              <div className="training-banner error" role="alert">
                {job.error}
              </div>
            ) : null}
          </div>
        ) : reviewing ? (
          <div className="training-dialog-scroll-body dataset-import-review">
            <DatasetInspectionSummary
              job={job!}
              sourceBytes={sourceBytes}
            />
            <label className="training-objective-field">
              <span>Dataset name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="training-objective-field">
              <span>Purpose</span>
              <textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <div className="dataset-import-mapping">
              <div>
                <strong>Semantic mapping</strong>
                <small>
                  Review which fields the policy can see and which stay
                  privileged for grading.
                </small>
              </div>
              <div className="dataset-import-mapping-table">
                {mapping!.bindings.map((binding, index) => (
                  <div key={`${binding.sourcePath}:${index}`}>
                    <code>{binding.sourcePath}</code>
                    <select
                      aria-label={`Target for ${binding.sourcePath}`}
                      value={binding.target}
                      onChange={(event) => updateBinding(index, {
                        target: event.target.value as DatasetMappingTarget,
                      })}
                    >
                      {TARGETS.map((target) => (
                        <option key={target} value={target}>{humanize(target)}</option>
                      ))}
                    </select>
                    <select
                      aria-label={`Policy for ${binding.sourcePath}`}
                      value={binding.policy}
                      onChange={(event) => updateBinding(index, {
                        policy: event.target.value as DatasetFieldBinding["policy"],
                      })}
                    >
                      {POLICIES.map((policy) => (
                        <option key={policy} value={policy}>{humanize(policy)}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            {requiresLicenseApproval ? (
              <label className="dataset-import-license-review">
                <input
                  checked={licenseApproved}
                  type="checkbox"
                  onChange={(event) => setLicenseApproved(event.target.checked)}
                />
                <span>
                  I reviewed the repository license and approve importing this
                  Dataset.
                </span>
              </label>
            ) : null}
            {job?.status === "failed" && job.error ? (
              <div className="training-banner error" role="alert">{job.error}</div>
            ) : null}
          </div>
        ) : (
          <DatasetImportProgress job={job!} />
        )}

        {localError ? (
          <div className="training-banner error" role="alert">{localError}</div>
        ) : null}
        <div className="training-dialog-actions">
          {!inspection ? (
            <button
              className="training-button"
              disabled={!locator.trim() || active}
              type="button"
              onClick={() => void inspect()}
            >
              {active ? <Loader2 className="spin" size={14} /> : null}
              Inspect Dataset
            </button>
          ) : reviewing ? (
            <>
              <button
                className="training-button secondary"
                type="button"
                onClick={onOpenDatasetStorageSettings}
              >
                Dataset storage
              </button>
              <button
                className="training-button"
                disabled={
                  !name.trim()
                  || !objective.trim()
                  || !mapping
                  || (requiresLicenseApproval && !licenseApproved)
                }
                type="button"
                onClick={() => void materialize()}
              >
                Import and save
              </button>
            </>
          ) : active ? (
            <>
              <button
                className="training-button secondary"
                type="button"
                onClick={onClose}
              >
                Run in background
              </button>
              <button
                className="training-button"
                disabled={job?.status === "cancelling"}
                type="button"
                onClick={() => void cancel()}
              >
                Cancel import
              </button>
            </>
          ) : (
            <button className="training-button" type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
    </AppDialog>
  );
}

function DatasetInspectionSummary({
  job,
  sourceBytes,
}: {
  job: DatasetImportJob;
  sourceBytes: number | null;
}) {
  const inspection = job.inspection!;
  const totalRows = inspection.splits.reduce<number | null>(
    (total, split) =>
      total === null || split.rowCount === null
        ? null
        : total + split.rowCount,
    0,
  );
  return (
    <div className="dataset-import-summary">
      <div>
        <strong>{inspection.title}</strong>
        <a
          href={inspection.locator.repositoryUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open on Hugging Face <ExternalLink size={12} />
        </a>
      </div>
      <dl>
        <div><dt>Revision</dt><dd><code>{inspection.resolvedRevision.slice(0, 12)}</code></dd></div>
        <div><dt>Rows</dt><dd>{totalRows === null ? "Unknown" : totalRows.toLocaleString()}</dd></div>
        <div><dt>Source size</dt><dd>{sourceBytes === null ? "Unknown" : formatBytes(sourceBytes)}</dd></div>
        <div><dt>License</dt><dd>{inspection.declaredLicense ?? "Review required"}</dd></div>
      </dl>
      <p>
        {inspection.splits.map((split) =>
          `${split.configuration}/${split.split}: ${split.rowCount?.toLocaleString() ?? "unknown"} rows`,
        ).join(" · ")}
      </p>
    </div>
  );
}

function DatasetImportProgress({ job }: { job: DatasetImportJob }) {
  const progress = job.progress;
  const bytePercent = progress.totalBytes && progress.totalBytes > 0
    ? Math.min(100, (progress.completedBytes / progress.totalBytes) * 100)
    : null;
  const rowPercent = progress.totalRows && progress.totalRows > 0
    ? Math.min(100, (progress.completedRows / progress.totalRows) * 100)
    : null;
  const percent = rowPercent ?? bytePercent;
  return (
    <div className="training-dialog-scroll-body dataset-import-progress" role="status">
      <Loader2 className={job.status === "ready" ? "" : "spin"} size={22} />
      <h3>{job.status === "ready" ? "Dataset saved" : "Importing Dataset"}</h3>
      <p>{job.progress.message}</p>
      <div className="dataset-import-progress-track">
        <span style={{ width: `${percent ?? 8}%` }} />
      </div>
      <small>
        {progress.completedRows
          ? `${progress.completedRows.toLocaleString()}${progress.totalRows ? ` of ${progress.totalRows.toLocaleString()}` : ""} rows`
          : progress.completedBytes
            ? `${formatBytes(progress.completedBytes)}${progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ""}`
            : humanize(progress.phase)}
      </small>
      {job.error ? <div className="training-banner error">{job.error}</div> : null}
    </div>
  );
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
