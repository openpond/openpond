import { CheckCircle2, Cloud, ExternalLink, Loader2, X } from "../icons";
import type { MouseEvent } from "react";

export type CloudSetupDialogState = {
  status: "confirm" | "uploading" | "ready" | "error";
  localProjectId?: string | null;
  cloudProjectId?: string | null;
  teamId?: string | null;
  projectName: string;
  projectKind: "local" | "cloud";
  projectUrl: string | null;
  setupUrl: string | null;
  branch: string | null;
  upload?: {
    fileCount: number;
    byteCount: number;
    skippedCount: number;
    initializedEmptyProject: boolean;
  } | null;
  error?: string | null;
};

type CloudSetupDialogProps = {
  state: CloudSetupDialogState | null;
  onClose: () => void;
  onOpenBrowserUrl?: (href: string, options?: { newTab?: boolean }) => void;
  onStart: () => void;
};

export function CloudSetupDialog({
  state,
  onClose,
  onOpenBrowserUrl,
  onStart,
}: CloudSetupDialogProps) {
  if (!state) return null;
  const busy = state.status === "uploading";
  const ready = state.status === "ready";
  const errored = state.status === "error";
  const isCloudProject = state.projectKind === "cloud";

  return (
    <div className="git-dialog-backdrop" role="presentation">
      <section
        className="git-dialog cloud-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Set up Cloud coding"
      >
        <button
          className="git-dialog-close"
          disabled={busy}
          type="button"
          onClick={onClose}
          aria-label="Close Cloud setup"
          title="Close"
        >
          <X size={14} />
        </button>
        <div className="git-dialog-icon">
          {ready ? <CheckCircle2 size={18} /> : <Cloud size={18} />}
        </div>
        <h2>{ready ? "Cloud repo ready" : "Set up Cloud coding"}</h2>
        <p>
          {ready
            ? "Your source is ready in OpenPond Git. Finish by creating the Cloud sandbox environment."
            : isCloudProject
              ? "This Cloud Project is ready for a sandbox environment."
              : "OpenPond will upload tracked and unignored files into OpenPond Git, then send you to the Cloud sandbox setup page."}
        </p>

        <div className="cloud-setup-summary">
          <div className="git-dialog-row">
            <span>Project</span>
            <strong>{state.projectName}</strong>
          </div>
          <div className="git-dialog-row">
            <span>Source</span>
            <strong>{isCloudProject ? "OpenPond Git" : "Local project upload"}</strong>
          </div>
          <div className="git-dialog-row">
            <span>Branch</span>
            <strong>{state.branch ?? "main"}</strong>
          </div>
        </div>

        {busy && (
          <div className="cloud-setup-progress" role="status" aria-live="polite">
            <Loader2 className="cloud-setup-spinner" size={16} />
            <span>Uploading source to OpenPond Git...</span>
          </div>
        )}

        {ready && state.upload && (
          <div className="cloud-setup-upload-result">
            <strong>
              {state.upload.initializedEmptyProject
                ? "Initialized empty project"
                : `Uploaded ${state.upload.fileCount} files`}
            </strong>
            <span>
              {formatBytes(state.upload.byteCount)}
              {state.upload.skippedCount > 0 ? ` · ${state.upload.skippedCount} skipped` : ""}
            </span>
          </div>
        )}

        {errored && (
          <div className="cloud-setup-error" role="alert">
            {state.error ?? "Cloud setup failed."}
          </div>
        )}

        {ready && state.setupUrl && (
          <div className="cloud-setup-next">
            {state.projectUrl ? (
              <span>
                Your repo is ready here:{" "}
                <a href={state.projectUrl} target="_blank" rel="noreferrer" onClick={(event) => openLinkInSidebar(event, state.projectUrl, onOpenBrowserUrl, { newTab: true })}>
                  Project page
                  <ExternalLink size={13} />
                </a>
              </span>
            ) : (
              <span>Your repo is ready. Next step:</span>
            )}
            <a href={state.setupUrl} target="_blank" rel="noreferrer" onClick={(event) => openLinkInSidebar(event, state.setupUrl, onOpenBrowserUrl)}>
              Setup the Cloud sandbox
              <ExternalLink size={13} />
            </a>
          </div>
        )}

        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={busy} type="button" onClick={onClose}>
            {ready ? "Done" : "Cancel"}
          </button>
          {ready ? (
            state.setupUrl ? (
              <a className="git-dialog-primary cloud-setup-primary-link" href={state.setupUrl} target="_blank" rel="noreferrer" onClick={(event) => openLinkInSidebar(event, state.setupUrl, onOpenBrowserUrl)}>
                Open setup
                <ExternalLink size={13} />
              </a>
            ) : null
          ) : (
            <button className="git-dialog-primary" disabled={busy} type="button" onClick={onStart}>
              {busy ? "Uploading" : errored ? "Try again" : isCloudProject ? "Show setup link" : "Upload source"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function openLinkInSidebar(
  event: MouseEvent<HTMLAnchorElement>,
  href: string | null,
  onOpenBrowserUrl: CloudSetupDialogProps["onOpenBrowserUrl"],
  options: { newTab?: boolean } = {},
): void {
  if (!href || !onOpenBrowserUrl) return;
  event.preventDefault();
  onOpenBrowserUrl(href, options);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
