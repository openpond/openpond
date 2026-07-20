import { useState } from "react";
import type { ClientConnection } from "../../api";
import "../../styles/settings/settings-layout.css";
import "../../styles/settings/settings-forms.css";
import "../../styles/settings/settings-lists.css";
import "../../styles/settings/compute-settings.css";
import { ComputeSettingsSection } from "../settings/ComputeSettingsSection";
import { useComputeSettings } from "../settings/useComputeSettings";
import { X } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";

export function TrainingComputeDialog({
  connection,
  onCandidatesChanged,
  onClose,
}: {
  connection: ClientConnection | null;
  onCandidatesChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error);
  const compute = useComputeSettings({
    connection,
    enabled: true,
    onError: setError,
  });

  async function close() {
    await onCandidatesChanged();
    onClose();
  }

  return (
    <div
      className="training-dialog-backdrop training-compute-dialog-backdrop"
      role="presentation"
      onMouseDown={() => void close()}
    >
      <section
        aria-label="Manage local models"
        aria-modal="true"
        className="training-dialog training-compute-dialog"
        role="dialog"
        onKeyDown={(event) => {
          const target = event.target;
          if (
            event.key === "Escape"
            && (!(target instanceof Node) || event.currentTarget.contains(target))
          ) {
            event.preventDefault();
            void close();
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div>
            <h2>Manage local models</h2>
            <p>
              Configure model storage, scan this machine, or download the
              bounded local correctness model.
            </p>
          </div>
          <button
            className="training-icon-button"
            type="button"
            aria-label="Close local model manager"
            onClick={() => void close()}
          >
            <X size={16} />
          </button>
        </div>
        <div className="training-dialog-scroll-body">
          <ComputeSettingsSection
            busy={compute.busy}
            state={compute.state}
            title="This machine"
            onCancelDownload={compute.cancelDownload}
            onDownloadSmolLm2={compute.downloadSmolLm2}
            onSave={compute.save}
            onScan={compute.scan}
          />
        </div>
      </section>
    </div>
  );
}
