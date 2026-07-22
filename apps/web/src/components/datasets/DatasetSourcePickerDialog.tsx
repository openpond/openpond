import { useState } from "react";
import { Boxes, DownloadCloud, UploadCloud, X } from "../icons";
import { AppDialog } from "../dialogs/AppDialog";

export type DatasetCreateSource = "build" | "huggingface" | "upload";

const SOURCES = [
  {
    id: "build" as const,
    title: "Build",
    description: "Create from a purpose, conversations, or both.",
    icon: Boxes,
    available: true,
  },
  {
    id: "huggingface" as const,
    title: "Hugging Face",
    description: "Paste a Dataset URL or repository ID.",
    icon: DownloadCloud,
    available: true,
  },
  {
    id: "upload" as const,
    title: "Upload file",
    description: "JSON, JSONL, CSV, and Parquet import is coming next.",
    icon: UploadCloud,
    available: false,
  },
];

export function DatasetSourcePickerDialog({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (source: DatasetCreateSource) => void;
}) {
  const [selectedSource, setSelectedSource] = useState<DatasetCreateSource | null>(null);
  const selected = SOURCES.find((source) => source.id === selectedSource) ?? null;

  return (
    <AppDialog
      ariaLabel="New Dataset"
      className="training-dialog training-run-dialog training-run-start-step"
      onClose={onClose}
    >
        <div className="training-dialog-header">
          <h2>New Dataset</h2>
          <button
            aria-label="Close"
            className="training-icon-button"
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="training-run-step-heading">
          <h3>Choose a source</h3>
          <p>
            Every source becomes the same immutable, Parquet-backed OpenPond
            Dataset.
          </p>
        </div>
        <div
          aria-label="How to create a Dataset"
          className="training-method-options training-start-mode-options"
          role="radiogroup"
        >
          {SOURCES.map((source) => {
            const Icon = source.icon;
            return (
              <button
                key={source.id}
                aria-describedby={
                  source.available ? undefined : `${source.id}-availability`
                }
                aria-checked={selectedSource === source.id}
                className={selectedSource === source.id ? "selected" : undefined}
                disabled={!source.available}
                role="radio"
                type="button"
                onClick={() => setSelectedSource(source.id)}
              >
                <span className="training-start-mode-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="training-start-mode-copy">
                  <strong>
                    {source.title}
                    {!source.available ? (
                      <span
                        className="dataset-source-availability"
                        id={`${source.id}-availability`}
                      >
                        Coming next
                      </span>
                    ) : null}
                  </strong>
                  <small>{source.description}</small>
                </span>
              </button>
            );
          })}
        </div>
        <div className="training-dialog-actions">
          <button
            className="training-button secondary"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="training-button"
            disabled={!selected}
            type="button"
            onClick={() => {
              if (selected) onSelect(selected.id);
            }}
          >
            {selectedSource === "build" ? "Create" : "Continue"}
          </button>
        </div>
    </AppDialog>
  );
}
