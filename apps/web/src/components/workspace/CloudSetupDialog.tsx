import { CheckCircle2, Cloud, ExternalLink, Loader2, X } from "../icons";
import type { MouseEvent } from "react";
import { useErrorToast } from "../../app/AppToastContext";

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
  preview?: {
    rootPath: string;
    branch: string;
    headCommit: string | null;
    targetProjectId: string | null;
    targetProjectName: string;
    fileCount: number;
    byteCount: number;
    skippedCount: number;
    initializedEmptyProject: boolean;
  } | null;
  previewLoading?: boolean;
  previewError?: string | null;
  upload?: {
    branch: string;
    headCommit: string | null;
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
  useErrorToast(state?.previewError, { prefix: "Upload preview" });
  useErrorToast(state?.error, { prefix: "Cloud setup" });
  if (!state) return null;
  const busy = state.status === "uploading";
  const ready = state.status === "ready";
  const errored = state.status === "error";
  const isCloudProject = state.projectKind === "cloud";
  const preview = state.preview ?? null;

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
            <strong>{preview?.branch ?? state.branch ?? "main"}</strong>
          </div>
          {!isCloudProject && (
            <div className="git-dialog-row">
              <span>Cloud project</span>
              <strong>{preview?.targetProjectId ?? state.cloudProjectId ?? "New on upload"}</strong>
            </div>
          )}
        </div>

        {!ready && !isCloudProject && (
          <div className="cloud-setup-upload-preview" role="status" aria-live="polite">
            {state.previewLoading ? (
              <>
                <strong>Calculating upload preview</strong>
                <span>Checking tracked and unignored files before anything is pushed.</span>
              </>
            ) : state.previewError ? (
              <>
                <strong>Preview unavailable</strong>
                <span>Close and reopen setup to try the preview again.</span>
              </>
            ) : preview ? (
              <>
                <strong>
                  {preview.initializedEmptyProject
                    ? "Will initialize an empty project"
                    : `Will upload ${preview.fileCount} files`}
                </strong>
                <span>
                  {uploadSummaryDetails({
                    byteCount: preview.byteCount,
                    skippedCount: preview.skippedCount,
                    headCommit: preview.headCommit,
                    targetProjectName: preview.targetProjectName,
                  })}
                </span>
              </>
            ) : (
              <>
                <strong>Upload preview pending</strong>
                <span>File count, byte count, and skipped files will appear here before upload.</span>
              </>
            )}
          </div>
        )}

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
              {uploadSummaryDetails({
                byteCount: state.upload.byteCount,
                skippedCount: state.upload.skippedCount,
                headCommit: state.upload.headCommit,
                targetProjectName: state.upload.branch,
              })}
            </span>
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

function uploadSummaryDetails({
  byteCount,
  skippedCount,
  headCommit,
  targetProjectName,
}: {
  byteCount: number;
  skippedCount: number;
  headCommit: string | null;
  targetProjectName: string;
}): string {
  const details = [formatBytes(byteCount), `${skippedCount} skipped`];
  const sourceRef = shortCommit(headCommit);
  if (sourceRef) details.push(`local ${sourceRef}`);
  details.push(targetProjectName);
  return details.join(" · ");
}

function shortCommit(value: string | null): string | null {
  const commit = value?.trim();
  return commit ? commit.slice(0, 7) : null;
}
